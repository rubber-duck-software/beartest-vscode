import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import { BeartestEvent } from "../types";

/** Commands sent from extension to runner (via stdin as JSON + newline) */
export type RunnerCommand =
  | { type: "run"; files: string[]; only?: string[] }
  | { type: "cancel" }
  | { type: "shutdown" };

/** Responses sent from runner to extension (via stdout with __BEARTEST_MESSAGE__ delimiters) */
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
}

interface BufferState {
  stdout: string;
  stderr: string;
}

const PROTOCOL_START = "__BEARTEST_MESSAGE__";
const PROTOCOL_END = "__END__";

// Pure functions for protocol parsing

/**
 * Parse protocol messages from a buffer, returning parsed messages and updated buffer
 */
const parseProtocolMessages = (
  buffer: string
): { messages: RunnerResponse[]; remainingBuffer: string } => {
  const messages: RunnerResponse[] = [];
  let currentBuffer = buffer;

  while (true) {
    const messageStart = currentBuffer.indexOf(PROTOCOL_START);
    if (messageStart === -1) break;

    const messageEnd = currentBuffer.indexOf(PROTOCOL_END, messageStart);
    if (messageEnd === -1) break; // Incomplete message

    const messageJson = currentBuffer.substring(
      messageStart + PROTOCOL_START.length,
      messageEnd
    );

    currentBuffer = currentBuffer.substring(messageEnd + PROTOCOL_END.length);

    try {
      messages.push(JSON.parse(messageJson));
    } catch (error) {
      console.error("Failed to parse runner message:", error);
    }
  }

  return { messages, remainingBuffer: currentBuffer };
};

/**
 * Extract non-protocol output from buffer
 */
const extractOutput = (
  buffer: string
): { output: string; remainingBuffer: string } => {
  if (!buffer || buffer.startsWith(PROTOCOL_START)) {
    return { output: "", remainingBuffer: buffer };
  }

  const lines = buffer.split("\n");
  const remainingBuffer = lines.pop() || "";
  const output = lines.join("\n");

  return {
    output: output ? output + "\n" : "",
    remainingBuffer,
  };
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
 * Send a command to the runner process
 */
const sendCommand = (child: ChildProcess, command: RunnerCommand): void => {
  if (!child.stdin?.writable) {
    throw new Error("Process stdin is not writable");
  }
  child.stdin.write(JSON.stringify(command) + "\n");
};

// Effectful process management

/**
 * Run tests using the protocol client
 * This is the main entry point that coordinates the protocol communication
 */
export const runWithProtocol = async (
  config: ProtocolConfig,
  handlers: ProtocolHandlers,
  testFiles: string[],
  only: string[] | undefined,
  token: vscode.CancellationToken
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const bufferState: BufferState = { stdout: "", stderr: "" };
    let isReady = false;

    const env = {
      ...process.env,
      BEARTEST_MODULE_PATH: config.beartestModulePath,
    };

    const child = spawn(
      config.command,
      [...config.runtimeArgs, config.runnerScriptPath],
      {
        cwd: config.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      }
    );

    // Handle protocol messages
    const handleMessages = async (messages: RunnerResponse[]) => {
      for (const message of messages) {
        switch (message.type) {
          case "ready":
            isReady = true;
            // Send run command when ready
            sendCommand(child, buildRunCommand(testFiles, only));
            break;
          case "event":
            await handlers.onEvent(message.data);
            break;
          case "complete":
            handlers.onComplete();
            resolve();
            break;
          case "error":
            handlers.onError(new Error(message.error.message));
            reject(new Error(message.error.message));
            break;
        }
      }
    };

    // Stdout handler
    child.stdout?.on("data", async (data) => {
      bufferState.stdout += data.toString();

      // Parse and handle protocol messages
      const { messages, remainingBuffer } = parseProtocolMessages(
        bufferState.stdout
      );
      bufferState.stdout = remainingBuffer;
      await handleMessages(messages);

      // Extract and forward non-protocol output
      const { output, remainingBuffer: finalBuffer } = extractOutput(
        bufferState.stdout
      );
      bufferState.stdout = finalBuffer;
      if (output) {
        handlers.onOutput(data.toString());
      }
    });

    // Stderr handler
    child.stderr?.on("data", (data) => {
      const output = data.toString();
      bufferState.stderr += output;
      handlers.onOutput(output);
    });

    // Process exit handler
    child.on("close", (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        const errorMessage =
          bufferState.stderr || `Runner exited with code ${code}`;
        reject(new Error(errorMessage));
      }
    });

    // Process error handler
    child.on("error", (err) => {
      reject(err);
    });

    // Cancellation handler
    token.onCancellationRequested(() => {
      if (isReady && child.stdin?.writable) {
        sendCommand(child, buildCancelCommand());
        setTimeout(() => {
          if (!child.killed) child.kill();
        }, 1000);
      } else {
        child.kill();
      }
      resolve();
    });
  });
};
