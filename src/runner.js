/**
 * Beartest Runner Script
 *
 * This script runs in a child process and handles direct communication with the beartest module.
 * It uses Node.js IPC to communicate with the VSCode extension.
 */

// Helper to safely send IPC messages (only works when spawned with IPC)
function safeSend(message) {
  if (process.send) {
    process.send(message);
  } else {
    // Running standalone (not as IPC child process) - log to stderr
    console.error("[Runner IPC]", JSON.stringify(message));
  }
}

// Get beartest module path from environment variable
const beartestModulePath = process.env.BEARTEST_MODULE_PATH;

if (!beartestModulePath) {
  safeSend({
    type: "error",
    error: {
      message: "BEARTEST_MODULE_PATH environment variable not set",
      stack: new Error().stack,
    },
  });
  process.exit(1);
}

let beartest;
try {
  beartest = require(beartestModulePath);
} catch (error) {
  safeSend({
    type: "error",
    error: {
      message: `Failed to load beartest module from ${beartestModulePath}: ${error.message}`,
      stack: error.stack,
    },
  });
  process.exit(1);
}

const { run } = beartest;

// Flag to track if we should cancel execution
let shouldCancel = false;

/**
 * Async iterable wrapper for file list
 */
async function* createFileIterable(files) {
  for (const file of files) {
    if (shouldCancel) break;
    yield file;
  }
}

/**
 * Run tests and stream events back to the extension
 */
async function runTests(files, only) {
  shouldCancel = false;

  try {
    const options = {
      files: createFileIterable(files),
    };

    // Add 'only' filter if provided
    if (only && only.length > 0) {
      options.only = only;
    }

    console.log(files);

    // Consume the async generator and forward events
    for await (const event of run(options)) {
      if (shouldCancel) break;

      safeSend({
        type: "event",
        data: event,
      });
    }

    safeSend({
      type: "complete",
      success: !shouldCancel,
    });
  } catch (error) {
    safeSend({
      type: "error",
      error: {
        message: error.message,
        stack: error.stack,
      },
    });
    safeSend({
      type: "complete",
      success: false,
    });
  }
}

// Handle commands from the extension
process.on("message", async (command) => {
  switch (command.type) {
    case "run":
      console.log(command.files);
      await runTests(command.files, command.only);
      break;

    case "cancel":
      shouldCancel = true;
      // Give it a moment to cancel gracefully
      setTimeout(() => {
        process.exit(0);
      }, 100);
      break;

    case "shutdown":
      process.exit(0);

    default:
      safeSend({
        type: "error",
        error: {
          message: `Unknown command type: ${command.type}`,
        },
      });
  }
});

// Signal that the runner is ready
safeSend({ type: "ready" });

// Handle process errors
process.on("uncaughtException", (error) => {
  safeSend({
    type: "error",
    error: {
      message: `Uncaught exception: ${error.message}`,
      stack: error.stack,
    },
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  safeSend({
    type: "error",
    error: {
      message: `Unhandled rejection: ${reason}`,
      stack: reason instanceof Error ? reason.stack : undefined,
    },
  });
  process.exit(1);
});
