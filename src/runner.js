/**
 * Beartest Runner Script
 *
 * This script runs in a child process and handles direct communication with the beartest module.
 * It uses a Unix domain socket for structured data communication with the VSCode extension.
 */

const { EventEmitter } = require("events");
const net = require("net");

// ============================================================================
// SocketProtocol - Handles JSON communication over Unix domain socket
// ============================================================================

/**
 * Creates a socket-based message protocol for JSON communication
 */
function createSocketProtocol(socketPath) {
  const emitter = new EventEmitter();
  let socket = null;
  let buffer = "";
  let isConnected = false;

  const send = (message) => {
    if (!socket || !isConnected) {
      throw new Error("Socket not connected");
    }
    const json = JSON.stringify(message);
    socket.write(json + "\n");
  };

  const sendError = (error) => {
    try {
      send({
        type: "error",
        error: {
          message: error.message,
          stack: error.stack,
        },
      });
    } catch (err) {
      // If we can't send error over socket, log to stderr
      console.error("Failed to send error over socket:", err);
      console.error("Original error:", error);
    }
  };

  const handleData = (chunk) => {
    buffer += chunk.toString();

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.substring(0, newlineIndex);
      buffer = buffer.substring(newlineIndex + 1);

      if (line.trim()) {
        try {
          const command = JSON.parse(line);
          emitter.emit("command", command);
        } catch (error) {
          sendError(new Error(`Failed to parse command: ${error.message}`));
        }
      }
    }
  };

  const connect = () => {
    return new Promise((resolve, reject) => {
      socket = net.createConnection(socketPath);

      socket.on("connect", () => {
        isConnected = true;
        socket.setEncoding("utf8");
        socket.on("data", handleData);
        resolve();
      });

      socket.on("error", (err) => {
        reject(new Error(`Socket connection error: ${err.message}`));
      });

      socket.on("close", () => {
        isConnected = false;
        emitter.emit("close");
      });
    });
  };

  return {
    send,
    sendError,
    connect,
    on: (event, handler) => emitter.on(event, handler),
  };
}

// ============================================================================
// TestRunner - Manages test execution and cancellation
// ============================================================================

/**
 * Creates a test runner with cancellation support
 */
function createTestRunner(beartest) {
  let shouldCancel = false;

  async function* createFileIterable(files) {
    for (const file of files) {
      if (shouldCancel) break;
      yield file;
    }
  }

  async function* run(files, only) {
    shouldCancel = false;

    const options = {
      files: createFileIterable(files),
    };

    if (only && only.length > 0) {
      options.only = only;
    }

    for await (const event of beartest.run(options)) {
      if (shouldCancel) break;
      yield event;
    }
  }

  const cancel = () => {
    shouldCancel = true;
  };

  const isCancelling = () => shouldCancel;

  return { run, cancel, isCancelling };
}

// ============================================================================
// CommandHandler - Routes commands and coordinates components
// ============================================================================

/**
 * Creates command handlers
 */
function createCommandHandlers(protocol, testRunner) {
  const handleRunCommand = async (command) => {
    try {
      for await (const event of testRunner.run(command.files, command.only)) {
        protocol.send({
          type: "event",
          data: event,
        });
      }

      protocol.send({
        type: "complete",
        success: !testRunner.isCancelling(),
      });

      // Exit after sending complete message (with small delay to flush stdout)
      setTimeout(() => process.exit(0), 100);
    } catch (error) {
      protocol.sendError(error);
      protocol.send({
        type: "complete",
        success: false,
      });

      // Exit after error too
      setTimeout(() => process.exit(1), 100);
    }
  };

  const handleCancelCommand = () => {
    testRunner.cancel();
    setTimeout(() => process.exit(0), 100);
  };

  const handleShutdownCommand = () => {
    process.exit(0);
  };

  const handleCommand = async (command) => {
    switch (command.type) {
      case "run":
        await handleRunCommand(command);
        break;
      case "cancel":
        handleCancelCommand();
        break;
      case "shutdown":
        handleShutdownCommand();
        break;
      default:
        protocol.sendError(new Error(`Unknown command type: ${command.type}`));
    }
  };

  return handleCommand;
}

// ============================================================================
// Initialization and Setup
// ============================================================================

/**
 * Load the beartest module from the environment variable
 */
function loadBeartestModule(protocol) {
  const beartestModulePath = process.env.BEARTEST_MODULE_PATH;

  if (!beartestModulePath) {
    protocol.sendError(
      new Error("BEARTEST_MODULE_PATH environment variable not set")
    );
    process.exit(1);
  }

  try {
    return require(beartestModulePath);
  } catch (error) {
    protocol.sendError(
      new Error(
        `Failed to load beartest module from ${beartestModulePath}: ${error.message}`
      )
    );
    process.exit(1);
  }
}

/**
 * Setup global error handlers
 */
function setupErrorHandlers(protocol) {
  process.on("uncaughtException", (error) => {
    protocol.sendError(new Error(`Uncaught exception: ${error.message}`));
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const error = new Error(`Unhandled rejection: ${message}`);
    if (reason instanceof Error) {
      error.stack = reason.stack;
    }
    protocol.sendError(error);
    process.exit(1);
  });
}

/**
 * Initialize and start the runner
 */
async function main() {
  const socketPath = process.env.BEARTEST_SOCKET_PATH;

  if (!socketPath) {
    console.error("BEARTEST_SOCKET_PATH environment variable not set");
    process.exit(1);
  }

  const protocol = createSocketProtocol(socketPath);

  try {
    // Connect to the socket server
    await protocol.connect();

    const beartest = loadBeartestModule(protocol);
    const testRunner = createTestRunner(beartest);
    const handleCommand = createCommandHandlers(protocol, testRunner);

    setupErrorHandlers(protocol);
    protocol.on("command", handleCommand);
    protocol.send({ type: "ready" });
  } catch (error) {
    console.error("Failed to initialize runner:", error);
    process.exit(1);
  }
}

main();
