import * as vscode from "vscode";
import { BeartestEvent } from "./types";
import {
  createOrGetTestItem,
  findFileTestItem,
  getTestItem,
} from "./testItemRegistry";

/**
 * Functional utilities for handling beartest events and updating VSCode test runs
 */

/**
 * Parse an error stack trace into VSCode format
 */
const parseStackTrace = (stack: string): vscode.TestMessageStackFrame[] => {
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
};

/**
 * Handle test:start event - create TestItem if needed and mark as started
 */
const handleTestStart = ({
  event,
  run,
  suiteStack,
  controller,
  testItemMap,
}: {
  event: BeartestEvent & { type: "test:start" };
  run: vscode.TestRun;
  suiteStack: vscode.TestItem[];
  controller: vscode.TestController;
  testItemMap: Map<string, vscode.TestItem>;
}): void => {
  const { name, nesting, type: testType } = event.data;

  // Nesting 0 is the file-level suite
  if (nesting === 0) {
    // Find the file TestItem
    const fileItem = findFileTestItem(controller.items, name);
    if (fileItem) {
      suiteStack[0] = fileItem;
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

  // Create or get the test item
  const testItem = createOrGetTestItem({
    controller,
    testItemMap,
    parent,
    name,
    nesting,
    testType: testType === "suite" ? "suite" : "test",
  });

  // If this is a suite, add it to the suite stack
  if (testType === "suite") {
    suiteStack[nesting] = testItem;
  }

  // Mark test as started
  run.started(testItem);
};

/**
 * Handle test:pass event
 */
const handleTestPass = ({
  event,
  run,
  suiteStack,
  controller,
  testItemMap,
}: {
  event: BeartestEvent & { type: "test:pass" };
  run: vscode.TestRun;
  suiteStack: vscode.TestItem[];
  controller: vscode.TestController;
  testItemMap: Map<string, vscode.TestItem>;
}): void => {
  const { name, nesting, skip, details } = event.data;
  if (nesting === 0) {
    // Find the file TestItem
    const fileItem = findFileTestItem(controller.items, name);
    if (fileItem) {
      if (skip) {
        run.skipped(fileItem);
      } else {
        run.passed(fileItem, details.duration_ms);
      }
    }
    return;
  } else {
    const testItem = getTestItem({
      testItemMap,
      parent: suiteStack[nesting - 1],
      name,
      nesting,
    });

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
};

/**
 * Handle test:fail event
 */
const handleTestFail = ({
  event,
  run,
  suiteStack,
  testItemMap,
  controller,
}: {
  event: BeartestEvent & { type: "test:fail" };
  run: vscode.TestRun;
  suiteStack: vscode.TestItem[];
  controller: vscode.TestController;
  testItemMap: Map<string, vscode.TestItem>;
}): void => {
  const { name, nesting, details } = event.data;
  if (nesting === 0) {
    // Find the file TestItem
    const fileItem = findFileTestItem(controller.items, name);
    if (fileItem) {
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
        message.stackTrace = parseStackTrace(error.stack);
      }

      run.failed(fileItem, message, details.duration_ms);
    }
    return;
  } else {
    const testItem = getTestItem({
      testItemMap,
      parent: suiteStack[nesting - 1],
      name,
      nesting,
    });

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
      message.stackTrace = parseStackTrace(error.stack);
    }

    run.failed(testItem, message, details.duration_ms);
  }
};

/**
 * Handle any beartest event and update the test run accordingly
 */
export const handleBeartestEvent = ({
  event,
  run,
  suiteStack,
  controller,
  testItemMap,
}: {
  event: BeartestEvent;
  run: vscode.TestRun;
  suiteStack: vscode.TestItem[];
  controller: vscode.TestController;
  testItemMap: Map<string, vscode.TestItem>;
}): void => {
  const { type } = event;

  switch (type) {
    case "test:start":
      handleTestStart({ event, run, suiteStack, controller, testItemMap });
      break;

    case "test:pass":
      handleTestPass({ event, run, suiteStack, testItemMap, controller });
      break;

    case "test:fail":
      handleTestFail({ event, run, suiteStack, testItemMap, controller });
      break;
  }
};
