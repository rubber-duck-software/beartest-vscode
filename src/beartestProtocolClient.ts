import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import * as net from "net";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { BeartestEvent } from "./types";

/** Commands sent from extension to runner (via socket as newline-delimited JSON) */
export type RunnerCommand =
  | { type: "run"; files: string[]; only?: string[] }
  | { type: "cancel" }
  | { type: "shutdown" };

/** Responses sent from runner to extension (via socket as newline-delimited JSON) */
export type RunnerResponse =
  | { type: "ready" }
  | { type: "event"; data: BeartestEvent }
  | { type: "complete"; success: boolean }
  | { type: "error"; error: { message: string; stack?: string } };

export interface ProtocolConfig {
  command: string;
  runtimeArgs: string[];
  runnerScriptPath: string;
  beartestModulePath: string;
  cwd: string;
}

export interface ProtocolHandlers {
  onEvent: (event: BeartestEvent) => Promise<void>;
  onOutput: (output: string) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
  onDebugPort?: (port: number) => void;
}

interface BufferState {
  socket: string;
  stderr: string;
}

// Pure functions for socket message parsing

/**
 * Parse newline-delimited JSON messages from a buffer
 */
const parseSocketMessages = (
  buffer: string
): { messages: RunnerResponse[]; remainingBuffer: string } => {
  const messages: RunnerResponse[] = [];
  let currentBuffer = buffer;

  let newlineIndex;
  while ((newlineIndex = currentBuffer.indexOf("\n")) !== -1) {
    const line = currentBuffer.substring(0, newlineIndex);
    currentBuffer = currentBuffer.substring(newlineIndex + 1);

    if (line.trim()) {
      try {
        messages.push(JSON.parse(line));
      } catch (error) {
        console.error("Failed to parse runner message:", error);
      }
    }
  }

  return { messages, remainingBuffer: currentBuffer };
};

/**
 * Build a run command
 */
const buildRunCommand = (files: string[], only?: string[]): RunnerCommand => ({
  type: "run",
  files,
  ...(only && only.length > 0 ? { only } : {}),
});

/**
 * Build a cancel command
 */
const buildCancelCommand = (): RunnerCommand => ({ type: "cancel" });

/**
 * Send a command to the runner process via socket
 */
const sendCommand = (socket: net.Socket, command: RunnerCommand): void => {
  if (!socket.writable) {
    throw new Error("Socket is not writable");
  }
  socket.write(JSON.stringify(command) + "\n");
};

/**
 * Generate a unique socket path for this test run
 */
const generateSocketPath = (): string => {
  const tmpDir = os.tmpdir();
  const socketName = `beartest-${process.pid}-${Date.now()}.sock`;
  return path.join(tmpDir, socketName);
};

/**
 * Clean up socket file if it exists
 */
const cleanupSocketFile = (socketPath: string): void => {
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch (error) {
    // Ignore errors during cleanup
  }
};

// Effectful process management

/**
 * Run tests using the socket-based protocol client
 * This is the main entry point that coordinates the socket communication
 */
export const runWithProtocol = async (
  config: ProtocolConfig,
  handlers: ProtocolHandlers,
  testFiles: string[],
  only: string[] | undefined,
  token: vscode.CancellationToken
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const bufferState: BufferState = { socket: "", stderr: "" };
    const socketPath = generateSocketPath();
    let socketServer: net.Server | null = null;
    let clientSocket: net.Socket | null = null;
    let child: ChildProcess | null = null;
    let isReady = false;
    let isComplete = false;

    // Cleanup function
    const cleanup = () => {
      if (clientSocket) {
        clientSocket.destroy();
        clientSocket = null;
      }
      if (socketServer) {
        socketServer.close();
        socketServer = null;
      }
      cleanupSocketFile(socketPath);
    };

    // Handle protocol messages
    const handleMessages = async (messages: RunnerResponse[]) => {
      for (const message of messages) {
        switch (message.type) {
          case "ready":
            isReady = true;
            // Send run command when ready
            if (clientSocket) {
              sendCommand(clientSocket, buildRunCommand(testFiles, only));
            }
            break;
          case "event":
            await handlers.onEvent(message.data);
            break;
          case "complete":
            isComplete = true;
            handlers.onComplete();
            cleanup();
            resolve();
            break;
          case "error":
            handlers.onError(new Error(message.error.message));
            cleanup();
            reject(new Error(message.error.message));
            break;
        }
      }
    };

    // Create socket server
    cleanupSocketFile(socketPath); // Clean up any existing socket file
    socketServer = net.createServer((socket) => {
      clientSocket = socket;
      socket.setEncoding("utf8");

      // Handle data from socket
      socket.on("data", async (data) => {
        bufferState.socket += data.toString();

        // Parse and handle protocol messages
        const { messages, remainingBuffer } = parseSocketMessages(
          bufferState.socket
        );
        bufferState.socket = remainingBuffer;
        await handleMessages(messages);
      });

      socket.on("error", (err) => {
        console.error("Socket error:", err);
        cleanup();
        reject(err);
      });

      socket.on("close", () => {
        if (!isComplete) {
          cleanup();
          resolve();
        }
      });
    });

    socketServer.on("error", (err) => {
      console.error("Socket server error:", err);
      cleanup();
      reject(err);
    });

    // Start listening on the socket
    socketServer.listen(socketPath, () => {
      // Once socket server is ready, spawn the runner process
      const env = {
        ...process.env,
        BEARTEST_MODULE_PATH: config.beartestModulePath,
        BEARTEST_SOCKET_PATH: socketPath,
        // Force color output even when stdout/stderr are piped
        // This ensures ANSI colors are preserved for display in VSCode's terminal
        FORCE_COLOR: "1",
      };

      child = spawn(
        config.command,
        [...config.runtimeArgs, config.runnerScriptPath],
        {
          cwd: config.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env,
        }
      );

      // Stdout handler - forward output to handlers
      child.stdout?.on("data", (data) => {
        handlers.onOutput(data.toString());
      });

      // Stderr handler - check for debugger port and forward output
      child.stderr?.on("data", (data) => {
        const output = data.toString();
        bufferState.stderr += output;

        // Check for debugger port in stderr output
        if (handlers.onDebugPort) {
          const debugMatch = output.match(
            /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)/
          );
          if (debugMatch) {
            const port = parseInt(debugMatch[1], 10);
            handlers.onDebugPort(port);
          }
        }

        handlers.onOutput(output);
      });

      // Process exit handler
      child.on("close", (code) => {
        if (!isComplete) {
          cleanup();
          if (code === 0 || code === null) {
            resolve();
          } else {
            const errorMessage =
              bufferState.stderr || `Runner exited with code ${code}`;
            reject(new Error(errorMessage));
          }
        }
      });

      // Process error handler
      child.on("error", (err) => {
        cleanup();
        reject(err);
      });

      // Cancellation handler
      token.onCancellationRequested(() => {
        if (isReady && clientSocket?.writable) {
          sendCommand(clientSocket, buildCancelCommand());
          setTimeout(() => {
            if (child && !child.killed) child.kill();
            cleanup();
          }, 1000);
        } else {
          if (child) child.kill();
          cleanup();
        }
        resolve();
      });
    });
  });
};
