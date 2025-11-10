import * as vscode from "vscode";
import * as path from "path";
import { BeartestEvent, testItemData, TestItemData } from "./types";

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
      // Import beartest dynamically
      const beartestPath = await this.findBeartestModule();
      const beartest = require(beartestPath);

      // Track suite stack for nesting
      const suiteStack: vscode.TestItem[] = [];
      let currentFileItem: vscode.TestItem | undefined;

      // Run beartest with the selected files
      for await (const event of beartest.run({ files: testFiles })) {
        if (token.isCancellationRequested) {
          break;
        }

        await this.handleBeartestEvent(event, run, suiteStack, (fileItem) => {
          currentFileItem = fileItem;
        });
      }

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
    const testFiles = this.getTestFilesToRun(request);

    if (testFiles.length === 0) {
      vscode.window.showWarningMessage("No test files selected for debugging");
      return;
    }

    // Find beartest CLI
    const beartestPath = await this.findBeartestModule();
    const beartestCliPath = path.join(path.dirname(beartestPath), "cli.js");

    // Create debug configuration
    const debugConfig: vscode.DebugConfiguration = {
      type: "node",
      request: "launch",
      name: "Debug Beartest",
      program: beartestCliPath,
      args: testFiles,
      console: "integratedTerminal",
      internalConsoleOptions: "neverOpen",
    };

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
    const { type, data } = event;
    const { name, nesting } = data;

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
   * Find the beartest module in node_modules
   */
  private async findBeartestModule(): Promise<string> {
    // Try to find beartest in workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error("No workspace folder found");
    }

    // Look for beartest in node_modules
    const beartestPath = path.join(
      workspaceFolders[0].uri.fsPath,
      "node_modules",
      "beartest",
      "index.js"
    );

    // Check if it exists (simple check, could be enhanced)
    try {
      require.resolve(beartestPath);
      return beartestPath;
    } catch {
      // Try relative path for development
      const relativePath = path.join(
        workspaceFolders[0].uri.fsPath,
        "beartest-js",
        "index.js"
      );

      try {
        require.resolve(relativePath);
        return relativePath;
      } catch {
        throw new Error(
          "Beartest module not found. Please install beartest in your workspace."
        );
      }
    }
  }
}
