/**
 * Beartest Runner Script
 *
 * This script runs in a child process and handles direct communication with the beartest module.
 * It uses a JSON protocol over stdout/stdin to communicate with the VSCode extension.
 */

const { EventEmitter } = require("events");

// ============================================================================
// MessageProtocol - Handles JSON communication over stdin/stdout
// ============================================================================

/**
 * Creates a message protocol for JSON communication
 */
function createMessageProtocol(
  inputStream = process.stdin,
  outputStream = process.stdout
) {
  const emitter = new EventEmitter();
  let buffer = "";

  const send = (message) => {
    const json = JSON.stringify(message);
    outputStream.write(`__BEARTEST_MESSAGE__${json}__END__\n`);
  };

  const sendError = (error) => {
    send({
      type: "error",
      error: {
        message: error.message,
        stack: error.stack,
      },
    });
  };

  const handleData = (chunk) => {
    buffer += chunk;

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

  const start = () => {
    inputStream.setEncoding("utf8");
    inputStream.on("data", handleData);
  };

  return {
    send,
    sendError,
    start,
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
function main() {
  const protocol = createMessageProtocol();
  const beartest = loadBeartestModule(protocol);
  const testRunner = createTestRunner(beartest);
  const handleCommand = createCommandHandlers(protocol, testRunner);

  setupErrorHandlers(protocol);
  protocol.on("command", handleCommand);
  protocol.start();
  protocol.send({ type: "ready" });
}

main();
