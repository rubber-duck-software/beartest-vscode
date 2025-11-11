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
import {
  loadConfigurations,
  groupFilesByConfig,
  ResolvedTestConfig,
} from "./configResolver";

/**
 * Recursively mark a test item and all its children as started
 */
const markItemAndChildrenAsStarted = (
  run: vscode.TestRun,
  item: vscode.TestItem
): void => {
  run.started(item);
  item.children.forEach((child) => {
    markItemAndChildrenAsStarted(run, child);
  });
};

/**
 * Mark all test items that will be run as started immediately
 */
const markTestItemsAsStarted = (
  run: vscode.TestRun,
  request: vscode.TestRunRequest,
  controller: vscode.TestController
): void => {
  if (request.include && request.include.length > 0) {
    // Mark specific items and their children
    for (const item of request.include) {
      markItemAndChildrenAsStarted(run, item);
    }
  } else {
    // Mark all items in the controller
    controller.items.forEach((item) => {
      markItemAndChildrenAsStarted(run, item);
    });
  }
};

/**
 * Create test profiles for the given controller
 * Returns an object with run and debug profiles
 */
export const createTestProfiles = (controller: vscode.TestController) => {
  const testItemMap = new Map<string, vscode.TestItem>();
  let isRunning = false;

  const runProfile = controller.createRunProfile(
    "Run Tests",
    vscode.TestRunProfileKind.Run,
    (request, token) =>
      executeTests(request, controller, testItemMap, token, false, {
        isRunning: () => isRunning,
        setRunning: (value: boolean) => { isRunning = value; }
      }),
    true // isDefault
  );

  const debugProfile = controller.createRunProfile(
    "Debug Tests",
    vscode.TestRunProfileKind.Debug,
    (request, token) =>
      executeTests(request, controller, testItemMap, token, true, {
        isRunning: () => isRunning,
        setRunning: (value: boolean) => { isRunning = value; }
      }),
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
  isDebug: boolean,
  runningState: {
    isRunning: () => boolean;
    setRunning: (value: boolean) => void;
  }
): Promise<void> => {
  // Prevent multiple concurrent test runs
  if (runningState.isRunning()) {
    vscode.window.showWarningMessage(
      "Tests are already running. Please wait for the current run to complete."
    );
    return;
  }

  runningState.setRunning(true);

  const run = controller.createTestRun(request);
  const testFiles = getTestFilesToRun(request, controller);

  // Mark all test items as started immediately
  markTestItemsAsStarted(run, request, controller);

  if (isDebug && testFiles.length === 0) {
    vscode.window.showWarningMessage("No test files selected for debugging");
    run.end();
    runningState.setRunning(false);
    return;
  }

  try {
    // Load configurations from settings
    const configurations = loadConfigurations();

    // Get workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error("No workspace folder found");
    }

    // Group test files by their resolved configuration
    const configGroups = groupFilesByConfig(
      testFiles,
      workspaceFolders,
      configurations
    );

    // Show info about how tests will be grouped
    if (configGroups.size > 1) {
      const groupDescriptions = Array.from(configGroups.values()).map(
        (group) =>
          `  - ${group.files.length} file(s) with ${group.config.command} (pattern: ${group.config.matchedPattern})`
      );
      console.log(
        `Running tests in ${configGroups.size} separate process group(s):\n${groupDescriptions.join("\n")}`
      );
    }

    // Run each configuration group separately
    for (const { config, files } of configGroups.values()) {
      if (token.isCancellationRequested) {
        break;
      }

      await runTestGroup({
        config,
        files,
        request,
        run,
        controller,
        testItemMap,
        token,
        isDebug,
      });
    }

    run.end();
    runningState.setRunning(false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = isDebug ? "Beartest debug" : "Beartest execution";
    vscode.window.showErrorMessage(`${prefix} failed: ${message}`);
    run.end();
    runningState.setRunning(false);
  }
};

/**
 * Run a group of test files with a specific configuration
 */
interface RunTestGroupParams {
  config: ResolvedTestConfig;
  files: string[];
  request: vscode.TestRunRequest;
  run: vscode.TestRun;
  controller: vscode.TestController;
  testItemMap: Map<string, vscode.TestItem>;
  token: vscode.CancellationToken;
  isDebug: boolean;
}

const runTestGroup = async (params: RunTestGroupParams): Promise<void> => {
  const { config, files, request, run, controller, testItemMap, token, isDebug } = params;

  // Apply debug flag to runtime args
  const runtimeArgs = isDebug
    ? [...config.runtimeArgs, "--inspect"]
    : config.runtimeArgs;

  const beartestModulePath = await findBeartestModule();
  const runnerScriptPath = path.join(__dirname, "runner.js");

  const protocolConfig: ProtocolConfig = {
    command: config.command,
    runtimeArgs,
    runnerScriptPath,
    beartestModulePath,
    cwd: config.cwd,
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
  await runWithProtocol(protocolConfig, handlers, files, only, token);
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
