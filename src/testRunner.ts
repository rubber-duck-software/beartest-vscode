import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";
import { BeartestEvent, testItemData, TestItemData } from "./types";

/**
 * JSON Protocol Types for communicating with the runner process over stdout/stdin
 */

/** Commands sent from extension to runner (via stdin as JSON + newline) */
type RunnerCommand =
  | { type: "run"; files: string[]; only?: string[] }
  | { type: "cancel" }
  | { type: "shutdown" };

/** Responses sent from runner to extension (via stdout with __BEARTEST_MESSAGE__ delimiters) */
type RunnerResponse =
  | { type: "ready" }
  | { type: "event"; data: BeartestEvent }
  | { type: "complete"; success: boolean }
  | { type: "error"; error: { message: string; stack?: string } };

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
    const testFiles = this.getTestFilesToRun(request);

    try {
      // Get configuration
      const config = vscode.workspace.getConfiguration("beartest");
      const command = config.get<string>("command", "node");
      const runtimeArgs = config.get<string[]>("runtimeArgs", []);

      // Find beartest module
      const beartestModulePath = await this.findBeartestModule();

      // Get runner script path (in the same directory as this extension's compiled code)
      const runnerScriptPath = path.join(__dirname, "runner.js");

      // Track suite stack for nesting
      const suiteStack: vscode.TestItem[] = [];

      // Build 'only' filter for granular test execution
      const only = this.buildOnlyFilter(request);

      // Spawn runner process with IPC
      await this.runBeartestProcess(
        command,
        runtimeArgs,
        runnerScriptPath,
        beartestModulePath,
        testFiles,
        token,
        run,
        async (event) => {
          await this.handleBeartestEvent(event, run, suiteStack, () => {});
        },
        only
      );

      run.end();
    } catch (error) {
      // If there's an error running beartest, report it
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Beartest execution failed: ${message}`);
      run.end();
    }
  }

  /**
   * Spawn beartest runner process and handle stdout/stdin communication
   */
  private async runBeartestProcess(
    command: string,
    runtimeArgs: string[],
    runnerScriptPath: string,
    beartestModulePath: string,
    testFiles: string[],
    token: vscode.CancellationToken,
    run: vscode.TestRun,
    onEvent: (event: BeartestEvent) => Promise<void>,
    only?: string[]
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Get workspace folder for cwd
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const cwd = workspaceFolders?.[0]?.uri.fsPath || process.cwd();

      const env = {
        ...process.env,
        BEARTEST_MODULE_PATH: beartestModulePath,
      };

      const child = spawn(command, [...runtimeArgs, runnerScriptPath], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
      let stderrBuffer = "";
      let stdoutBuffer = "";
      let isReady = false;

      // Parse and handle messages from stdout
      const handleMessage = async (message: RunnerResponse) => {
        switch (message.type) {
          case "ready":
            // Runner is ready, send the run command
            isReady = true;
            const runCommand: RunnerCommand = {
              type: "run",
              files: testFiles,
              ...(only && only.length > 0 ? { only } : {}),
            };
            child.stdin?.write(JSON.stringify(runCommand) + "\n");
            break;

          case "event":
            // Forward beartest event to handler
            await onEvent(message.data);
            break;

          case "complete":
            // Test run completed
            resolve();
            break;

          case "error":
            // Runner encountered an error
            reject(new Error(message.error.message));
            break;
        }
      };

      // Capture stdout - parse protocol messages and forward other output
      child.stdout?.on("data", (data) => {
        stdoutBuffer += data.toString();

        // Look for protocol messages
        let messageStart;
        while ((messageStart = stdoutBuffer.indexOf("__BEARTEST_MESSAGE__")) !== -1) {
          const messageEnd = stdoutBuffer.indexOf("__END__", messageStart);

          if (messageEnd === -1) {
            // Incomplete message, wait for more data
            break;
          }

          // Extract the message
          const messageJson = stdoutBuffer.substring(
            messageStart + "__BEARTEST_MESSAGE__".length,
            messageEnd
          );

          // Remove processed message from buffer
          stdoutBuffer = stdoutBuffer.substring(messageEnd + "__END__".length);

          try {
            const message = JSON.parse(messageJson);
            handleMessage(message);
          } catch (error) {
            console.error("Failed to parse runner message:", error);
          }
        }

        // Any remaining output (non-protocol messages) goes to test output
        if (stdoutBuffer && !stdoutBuffer.startsWith("__BEARTEST_MESSAGE__")) {
          const lines = stdoutBuffer.split("\n");
          // Keep the last incomplete line in the buffer
          stdoutBuffer = lines.pop() || "";
          const output = lines.join("\n");
          if (output) {
            run.appendOutput(output + "\n");
          }
        }
      });

      // Capture stderr and forward to test results window
      child.stderr?.on("data", (data) => {
        const output = data.toString();
        stderrBuffer += output;
        run.appendOutput(output);
      });

      // Handle process exit
      child.on("close", (code) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          const errorMessage =
            stderrBuffer || `Runner exited with code ${code}`;
          reject(new Error(errorMessage));
        }
      });

      // Handle process errors
      child.on("error", (err) => {
        reject(err);
      });

      // Handle cancellation
      token.onCancellationRequested(() => {
        if (isReady && child.stdin?.writable) {
          // Send cancel command to runner for graceful shutdown
          const cancelCommand: RunnerCommand = { type: "cancel" };
          child.stdin?.write(JSON.stringify(cancelCommand) + "\n");

          // Force kill after timeout
          setTimeout(() => {
            if (!child.killed) {
              child.kill();
            }
          }, 1000);
        } else {
          child.kill();
        }
        resolve();
      });
    });
  }

  /**
   * Debug tests (similar to run but with debugger attached)
   */
  private async debugTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
  ): Promise<void> {
    const testFiles = this.getTestFilesToRun(request);

    if (testFiles.length === 0) {
      vscode.window.showWarningMessage("No test files selected for debugging");
      return;
    }

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
    const cwd = workspaceFolders?.[0]?.uri.fsPath;

    // Create debug configuration
    const debugConfig: vscode.DebugConfiguration = {
      type: "node",
      request: "launch",
      name: "Debug Beartest",
      program: runnerScriptPath,
      args: [],
      cwd,
      console: "integratedTerminal",
      internalConsoleOptions: "neverOpen",
      env: {
        BEARTEST_MODULE_PATH: beartestModulePath,
      },
    };

    // Use custom command if not default
    if (command !== "node") {
      debugConfig.runtimeExecutable = command;
    }

    // Add runtime args if specified
    if (runtimeArgs.length > 0) {
      debugConfig.runtimeArgs = runtimeArgs;
    }

    // Start debugging session
    await vscode.debug.startDebugging(undefined, debugConfig);
  }

  /**
   * Handle a beartest event and update the test run accordingly
   */
  private async handleBeartestEvent(
    event: BeartestEvent,
    run: vscode.TestRun,
    suiteStack: vscode.TestItem[],
    setCurrentFile: (fileItem: vscode.TestItem) => void
  ): Promise<void> {
    const { type } = event;

    switch (type) {
      case "test:start":
        await this.handleTestStart(event, run, suiteStack, setCurrentFile);
        break;

      case "test:pass":
        this.handleTestPass(event, run, suiteStack);
        break;

      case "test:fail":
        this.handleTestFail(event, run, suiteStack);
        break;
    }
  }

  /**
   * Handle test:start event - create TestItem if needed and mark as started
   */
  private async handleTestStart(
    event: BeartestEvent & { type: "test:start" },
    run: vscode.TestRun,
    suiteStack: vscode.TestItem[],
    setCurrentFile: (fileItem: vscode.TestItem) => void
  ): Promise<void> {
    const { name, nesting, type: testType } = event.data;

    // Nesting 0 is the file-level suite
    if (nesting === 0) {
      // Find the file TestItem
      const fileItem = this.findFileTestItem(name);
      if (fileItem) {
        suiteStack[0] = fileItem;
        setCurrentFile(fileItem);
        run.started(fileItem);
      }
      return;
    }

    // For nested tests/suites, create TestItem under parent
    const parent = suiteStack[nesting - 1];
    if (!parent) {
      console.warn(
        `No parent found for test at nesting level ${nesting}: ${name}`
      );
      return;
    }

    // Create a unique ID for this test
    const testId = this.createTestId(parent, name, nesting);

    // Check if TestItem already exists
    let testItem = this.testItemMap.get(testId);

    if (!testItem) {
      // Create new TestItem
      testItem = this.controller.createTestItem(testId, name, parent.uri);

      // Store metadata
      testItemData.set(testItem, {
        type: testType === "suite" ? "suite" : "test",
        fullName: name,
        nestingLevel: nesting,
        discovered: true,
      });

      // Add to parent's children
      parent.children.add(testItem);

      // Add to map for quick lookup
      this.testItemMap.set(testId, testItem);
    }

    // If this is a suite, add it to the suite stack
    if (testType === "suite") {
      suiteStack[nesting] = testItem;
    }

    // Mark test as started
    run.started(testItem);
  }

  /**
   * Handle test:pass event
   */
  private handleTestPass(
    event: BeartestEvent & { type: "test:pass" },
    run: vscode.TestRun,
    suiteStack: vscode.TestItem[]
  ): void {
    const { name, nesting, skip, details } = event.data;
    const testItem = suiteStack[nesting];

    if (!testItem) {
      console.warn(
        `No test item found for passed test at nesting ${nesting}: ${name}`
      );
      return;
    }

    if (skip) {
      run.skipped(testItem);
    } else {
      run.passed(testItem, details.duration_ms);
    }
  }

  /**
   * Handle test:fail event
   */
  private handleTestFail(
    event: BeartestEvent & { type: "test:fail" },
    run: vscode.TestRun,
    suiteStack: vscode.TestItem[]
  ): void {
    const { name, nesting, details } = event.data;
    const testItem = suiteStack[nesting];

    if (!testItem) {
      console.warn(
        `No test item found for failed test at nesting ${nesting}: ${name}`
      );
      return;
    }

    // Extract error message
    const error = details.error;
    let errorMessage = error.message || String(error);

    // Beartest wraps errors - try to extract the cause
    if (error.cause && error.cause instanceof Error) {
      errorMessage = error.cause.message;
    }

    // Create test message with stack trace
    const message = new vscode.TestMessage(errorMessage);
    if (error.stack) {
      message.stackTrace = this.parseStackTrace(error.stack);
    }

    run.failed(testItem, message, details.duration_ms);
  }

  /**
   * Parse error stack trace into VSCode format
   */
  private parseStackTrace(stack: string): vscode.TestMessageStackFrame[] {
    const frames: vscode.TestMessageStackFrame[] = [];
    const lines = stack.split("\n");

    for (const line of lines) {
      // Match stack trace lines like "at functionName (file:line:column)"
      const match = line.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/);
      if (match) {
        const [, label, file, lineStr, columnStr] = match;
        const uri = vscode.Uri.file(file);
        const lineNum = parseInt(lineStr, 10) - 1; // VSCode uses 0-based
        const column = parseInt(columnStr, 10) - 1;

        frames.push({
          uri,
          position: new vscode.Position(lineNum, column),
          label: label || "",
        });
      }
    }

    return frames;
  }

  /**
   * Get the list of test files to run based on the request
   */
  private getTestFilesToRun(request: vscode.TestRunRequest): string[] {
    const files: string[] = [];

    if (request.include) {
      // Run specific tests
      for (const item of request.include) {
        const filePath = this.getFilePathForTestItem(item);
        if (filePath && !files.includes(filePath)) {
          files.push(filePath);
        }
      }
    } else {
      // Run all tests in the workspace
      this.controller.items.forEach((item) => {
        this.collectFilesFromItem(item, files);
      });
    }

    return files;
  }

  /**
   * Get the file path for a TestItem (traverses up to find file-level item)
   */
  private getFilePathForTestItem(item: vscode.TestItem): string | undefined {
    const data = testItemData.get(item);

    if (data?.type === "file" && data.filePath) {
      return data.filePath;
    }

    // Traverse up to find the file item
    if (item.parent) {
      return this.getFilePathForTestItem(item.parent);
    }

    // If no parent, check if this is a folder - shouldn't run folders
    return undefined;
  }

  /**
   * Recursively collect all file paths from a TestItem tree
   */
  private collectFilesFromItem(item: vscode.TestItem, files: string[]): void {
    const data = testItemData.get(item);

    if (data?.type === "file" && data.filePath) {
      if (!files.includes(data.filePath)) {
        files.push(data.filePath);
      }
    } else {
      // Recurse into children
      item.children.forEach((child) => {
        this.collectFilesFromItem(child, files);
      });
    }
  }

  /**
   * Find a file TestItem by name
   */
  private findFileTestItem(fileName: string): vscode.TestItem | undefined {
    // Search through all items to find matching file
    let result: vscode.TestItem | undefined;

    const search = (collection: vscode.TestItemCollection): boolean => {
      let found = false;
      collection.forEach((item) => {
        if (found) return;

        const data = testItemData.get(item);
        if (data?.type === "file" && data.fullName === fileName) {
          result = item;
          found = true;
          return;
        }

        // Search children (folders)
        if (item.children.size > 0) {
          found = search(item.children);
        }
      });
      return found;
    };

    search(this.controller.items);
    return result;
  }

  /**
   * Create a unique ID for a test item
   */
  private createTestId(
    parent: vscode.TestItem,
    name: string,
    nesting: number
  ): string {
    return `${parent.id}::${nesting}::${name}`;
  }

  /**
   * Build the 'only' filter for granular test execution
   * Returns an array of test names forming the path to the selected test/suite
   */
  private buildOnlyFilter(
    request: vscode.TestRunRequest
  ): string[] | undefined {
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
    // Note: If multiple tests are selected, beartest's 'only' parameter
    // currently only supports filtering to a single test path
    const firstNestedItem = request.include.find((item) => {
      const data = testItemData.get(item);
      return data?.type !== "file";
    });

    if (!firstNestedItem) {
      return undefined;
    }

    // Build the path from file to this test
    return this.buildTestPath(firstNestedItem);
  }

  /**
   * Build the path of test/suite names from the file to the given test item
   */
  private buildTestPath(item: vscode.TestItem): string[] {
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
