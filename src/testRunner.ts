import * as vscode from "vscode";
import * as path from "path";
import { testItemData } from "./types";
import {
  runWithProtocol,
  ProtocolConfig,
  ProtocolHandlers,
} from "./beartestProtocolClient";
import { getTestFilesToRun } from "./testItemRegistry";
import { handleBeartestEvent } from "./eventHandlers";

/**
 * Create test profiles for the given controller
 * Returns an object with run and debug profiles
 */
export const createTestProfiles = (controller: vscode.TestController) => {
  const testItemMap = new Map<string, vscode.TestItem>();

  const runProfile = controller.createRunProfile(
    "Run Tests",
    vscode.TestRunProfileKind.Run,
    (request, token) =>
      executeTests(request, controller, testItemMap, token, false),
    true // isDefault
  );

  const debugProfile = controller.createRunProfile(
    "Debug Tests",
    vscode.TestRunProfileKind.Debug,
    (request, token) =>
      executeTests(request, controller, testItemMap, token, true),
    false
  );

  return { runProfile, debugProfile };
};

/**
 * Execute tests with the beartest protocol
 */
const executeTests = async (
  request: vscode.TestRunRequest,
  controller: vscode.TestController,
  testItemMap: Map<string, vscode.TestItem>,
  token: vscode.CancellationToken,
  isDebug: boolean
): Promise<void> => {
  const run = controller.createTestRun(request);
  const testFiles = getTestFilesToRun(request, controller);

  if (isDebug && testFiles.length === 0) {
    vscode.window.showWarningMessage("No test files selected for debugging");
    run.end();
    return;
  }

  try {
    // Gather configuration
    const config = vscode.workspace.getConfiguration("beartest");
    const command = config.get<string>("command", "node");
    const runtimeArgs = config.get<string[]>("runtimeArgs", []);
    const beartestModulePath = await findBeartestModule();
    const runnerScriptPath = path.join(__dirname, "runner.js");
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cwd = workspaceFolders?.[0]?.uri.fsPath || process.cwd();

    const protocolConfig: ProtocolConfig = {
      command,
      runtimeArgs,
      runnerScriptPath,
      beartestModulePath,
      cwd,
    };

    const suiteStack: vscode.TestItem[] = [];
    const handlers: ProtocolHandlers = {
      onEvent: async (event) => {
        handleBeartestEvent({
          event,
          run,
          suiteStack,
          controller,
          testItemMap,
        });
      },
      onOutput: (output) => run.appendOutput(normalizeOutput(output)),
      onComplete: () => {},
      onError: (error) => {
        vscode.window.showErrorMessage(
          `Beartest execution failed: ${error.message}`
        );
      },
      ...(isDebug && {
        onDebugPort: async (port) => {
          const debugConfig: vscode.DebugConfiguration = {
            type: "node",
            request: "attach",
            name: "Attach to Beartest",
            port,
            skipFiles: ["<node_internals>/**"],
          };
          await vscode.debug.startDebugging(undefined, debugConfig);
        },
      }),
    };

    const only = buildOnlyFilter(request);
    await runWithProtocol(protocolConfig, handlers, testFiles, only, token);
    run.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = isDebug ? "Beartest debug" : "Beartest execution";
    vscode.window.showErrorMessage(`${prefix} failed: ${message}`);
    run.end();
  }
};

/**
 * Normalize output for VSCode test run display (LF -> CRLF)
 * Called multiple times per test run (once per output chunk)
 */
const normalizeOutput = (output: string): string =>
  output.replace(/\r?\n/g, "\r\n");

/**
 * Find the beartest module in node_modules using Node's module resolution
 * Inspired by Vitest's multi-strategy package resolution approach
 */
const findBeartestModule = async (): Promise<string> => {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    throw new Error("No workspace folder found");
  }

  const errors: string[] = [];

  // Strategy 1: Try each workspace folder using Node's module resolution
  for (const folder of workspaceFolders) {
    try {
      const beartestPath = require.resolve("beartest-js", {
        paths: [folder.uri.fsPath],
      });
      return beartestPath;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors.push(`  ${folder.name}: ${errorMsg}`);
    }
  }

  // Strategy 2: Development mode - check for beartest-js sibling directory
  for (const folder of workspaceFolders) {
    try {
      const parentDir = path.dirname(folder.uri.fsPath);
      const devBeartestPath = path.join(parentDir, "beartest-js", "index.js");
      require.resolve(devBeartestPath);
      return devBeartestPath;
    } catch {
      // Continue to next folder
    }
  }

  // Strategy 3: Check relative to the extension's installation directory
  try {
    const extensionDir = path.dirname(__dirname);
    const siblingBeartestPath = path.join(
      path.dirname(extensionDir),
      "beartest-js",
      "index.js"
    );
    require.resolve(siblingBeartestPath);
    return siblingBeartestPath;
  } catch {
    // Continue to error
  }

  // If not found, provide helpful error message
  const errorMessage = [
    "Beartest module not found in any workspace folder.",
    "Please install beartest by running:",
    "  npm install --save-dev beartest-js",
    "",
    "Searched in:",
    ...errors,
  ].join("\n");

  throw new Error(errorMessage);
};

/**
 * Build the 'only' filter for granular test execution
 */
export const buildOnlyFilter = (
  request: vscode.TestRunRequest
): string[] | undefined => {
  // If no specific items are included, run all tests (no filter)
  if (!request.include || request.include.length === 0) {
    return undefined;
  }

  // Check if any included item is a nested test/suite (not a file)
  const hasNestedTests = request.include.some((item) => {
    const data = testItemData.get(item);
    return data?.type !== "file";
  });

  // If only files are selected, no need for 'only' filter
  if (!hasNestedTests) {
    return undefined;
  }

  // Build path for the first nested test/suite
  const firstNestedItem = request.include.find((item) => {
    const data = testItemData.get(item);
    return data?.type !== "file";
  });

  if (!firstNestedItem) {
    return undefined;
  }

  // Build the path from file to this test
  return buildTestPath(firstNestedItem);
};

/**
 * Build the path of test/suite names from file to the given test item
 */
const buildTestPath = (item: vscode.TestItem): string[] => {
  const path: string[] = [];
  let current: vscode.TestItem | undefined = item;

  // Traverse up to the file level, collecting names
  while (current) {
    const data = testItemData.get(current);

    // Stop when we reach the file level
    if (data?.type === "file") {
      break;
    }

    // Add the test/suite name to the path (at the beginning since we're going up)
    if (data?.fullName) {
      path.unshift(data.fullName);
    }

    // Move to parent
    current = current.parent;
  }

  return path;
};
