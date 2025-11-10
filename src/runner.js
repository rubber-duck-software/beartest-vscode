/**
 * Beartest Runner Script
 *
 * This script runs in a child process and handles direct communication with the beartest module.
 * It uses a JSON protocol over stdout/stdin to communicate with the VSCode extension.
 */

// Helper to send JSON messages over stdout
function safeSend(message) {
  // Send messages as JSON on stdout with a delimiter
  console.log("__BEARTEST_MESSAGE__" + JSON.stringify(message) + "__END__");
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

// Buffer for incoming stdin data
let stdinBuffer = "";

// Handle commands from the extension via stdin
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;

  // Process complete messages (terminated by newline)
  let newlineIndex;
  while ((newlineIndex = stdinBuffer.indexOf("\n")) !== -1) {
    const line = stdinBuffer.substring(0, newlineIndex);
    stdinBuffer = stdinBuffer.substring(newlineIndex + 1);

    if (line.trim()) {
      try {
        const command = JSON.parse(line);
        handleCommand(command);
      } catch (error) {
        safeSend({
          type: "error",
          error: {
            message: `Failed to parse command: ${error.message}`,
          },
        });
      }
    }
  }
});

// Handle a command from the extension
async function handleCommand(command) {
  switch (command.type) {
    case "run":
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
}

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
