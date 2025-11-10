import * as vscode from "vscode";
import * as path from "path";
import { BeartestEvent } from "./types";
import {
  runWithProtocol,
  ProtocolConfig,
  ProtocolHandlers,
} from "./protocol/BeartestProtocolClient";
import {
  getTestFilesToRun,
  buildOnlyFilter,
} from "./testItems/testItemRegistry";
import { handleBeartestEvent } from "./events/eventHandlers";

/**
 * Handles test execution and maps beartest events to VSCode Test Explorer
 */
export class TestRunner {
  // Map of test item IDs to TestItems for quick lookup
  private testItemMap = new Map<string, vscode.TestItem>();

  constructor(private controller: vscode.TestController) {}

  /**
   * Create a run profile for executing tests
   */
  createRunProfile(): vscode.TestRunProfile {
    return this.controller.createRunProfile(
      "Run Tests",
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token),
      true // isDefault
    );
  }

  /**
   * Create a debug profile for debugging tests
   */
  createDebugProfile(): vscode.TestRunProfile {
    return this.controller.createRunProfile(
      "Debug Tests",
      vscode.TestRunProfileKind.Debug,
      (request, token) => this.debugTests(request, token),
      false
    );
  }

  /**
   * Execute tests based on the test request
   */
  private async runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
  ): Promise<void> {
    const run = this.controller.createTestRun(request);
    const testFiles = getTestFilesToRun(request, this.controller);

    try {
      // Get configuration
      const config = vscode.workspace.getConfiguration("beartest");
      const command = config.get<string>("command", "node");
      const runtimeArgs = config.get<string[]>("runtimeArgs", []);

      // Find beartest module
      const beartestModulePath = await this.findBeartestModule();

      // Get runner script path
      const runnerScriptPath = path.join(__dirname, "runner.js");

      // Get workspace folder for cwd
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const cwd = workspaceFolders?.[0]?.uri.fsPath || process.cwd();

      // Track suite stack for nesting
      const suiteStack: vscode.TestItem[] = [];

      // Build 'only' filter for granular test execution
      const only = buildOnlyFilter(request);

      // Protocol configuration
      const protocolConfig: ProtocolConfig = {
        command,
        runtimeArgs,
        runnerScriptPath,
        beartestModulePath,
        cwd,
      };

      // Protocol handlers
      const handlers: ProtocolHandlers = {
        onEvent: async (event) => {
          handleBeartestEvent({
            event,
            run,
            suiteStack,
            controller: this.controller,
            testItemMap: this.testItemMap,
          });
        },
        onOutput: (output) => run.appendOutput(output),
        onComplete: () => {},
        onError: (error) => {
          vscode.window.showErrorMessage(
            `Beartest execution failed: ${error.message}`
          );
        },
      };

      // Run tests using protocol
      await runWithProtocol(protocolConfig, handlers, testFiles, only, token);

      run.end();
    } catch (error) {
      // If there's an error running beartest, report it
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Beartest execution failed: ${message}`);
      run.end();
    }
  }

  /**
   * Debug tests (similar to run but with debugger attached)
   */
  private async debugTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
  ): Promise<void> {
    const run = this.controller.createTestRun(request);
    const testFiles = getTestFilesToRun(request, this.controller);

    if (testFiles.length === 0) {
      vscode.window.showWarningMessage("No test files selected for debugging");
      run.end();
      return;
    }

    try {
      // Get configuration
      const config = vscode.workspace.getConfiguration("beartest");
      const command = config.get<string>("command", "node");
      const runtimeArgs = config.get<string[]>("runtimeArgs", []);

      // Add inspect-brk flag for debugging
      const debugRuntimeArgs = this.injectDebugFlag(command, runtimeArgs);

      // Find beartest module
      const beartestModulePath = await this.findBeartestModule();

      // Get runner script path
      const runnerScriptPath = path.join(__dirname, "runner.js");

      // Get workspace folder for cwd
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const cwd = workspaceFolders?.[0]?.uri.fsPath || process.cwd();

      // Track suite stack for nesting
      const suiteStack: vscode.TestItem[] = [];

      // Build 'only' filter for granular test execution
      const only = buildOnlyFilter(request);

      // Protocol configuration with debug args
      const protocolConfig: ProtocolConfig = {
        command,
        runtimeArgs: debugRuntimeArgs,
        runnerScriptPath,
        beartestModulePath,
        cwd,
      };

      // Protocol handlers
      const handlers: ProtocolHandlers = {
        onEvent: async (event) => {
          handleBeartestEvent({
            event,
            run,
            suiteStack,
            controller: this.controller,
            testItemMap: this.testItemMap,
          });
        },
        onOutput: (output) => run.appendOutput(output),
        onComplete: () => {},
        onError: (error) => {
          vscode.window.showErrorMessage(
            `Beartest execution failed: ${error.message}`
          );
        },
        onDebugPort: async (port) => {
          // Attach debugger to the detected port
          const debugConfig: vscode.DebugConfiguration = {
            type: "node",
            request: "attach",
            name: "Attach to Beartest",
            port,
            skipFiles: ["<node_internals>/**"],
          };
          await vscode.debug.startDebugging(undefined, debugConfig);
        },
      };

      // Run tests using protocol with debugging enabled
      await runWithProtocol(protocolConfig, handlers, testFiles, only, token);

      run.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Beartest debug failed: ${message}`);
      run.end();
    }
  }

  /**
   * Inject --inspect-brk flag into runtime args for debugging
   * Handles both direct node execution and wrapper commands (pnpm, npm, etc.)
   */
  private injectDebugFlag(_command: string, runtimeArgs: string[]): string[] {
    // Append debug flag to runtime args
    return [...runtimeArgs, "--inspect-brk=0"];
  }

  /**
   * Find the beartest module in node_modules using Node's module resolution
   * Inspired by Vitest's multi-strategy package resolution approach
   */
  private async findBeartestModule(): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error("No workspace folder found");
    }

    const errors: string[] = [];

    // Strategy 1: Try each workspace folder using Node's module resolution
    for (const folder of workspaceFolders) {
      try {
        // Use Node's module resolution from the workspace folder's context
        // This respects node_modules, package.json, and proper resolution order
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
    // This handles the case where beartest-js is being developed alongside the extension
    for (const folder of workspaceFolders) {
      try {
        // Check for beartest-js in parent directory (development scenario)
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
  }
}
