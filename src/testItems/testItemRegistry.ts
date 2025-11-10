import * as vscode from "vscode";
import { testItemData } from "../types";

/**
 * Pure functions and utilities for managing VSCode TestItems
 */

/**
 * Create a unique ID for a test item based on parent, name, and nesting level
 */
const createTestId = ({
  parent,
  name,
  nesting,
}: {
  parent: vscode.TestItem;
  name: string;
  nesting: number;
}): string => {
  return `${parent.id}::${nesting}::${name}`;
};

/**
 * Get file path from a test item by traversing up the tree
 */
const getFilePathForTestItem = (item: vscode.TestItem): string | undefined => {
  const data = testItemData.get(item);

  if (data?.type === "file" && data.filePath) {
    return data.filePath;
  }

  // Traverse up to find the file item
  if (item.parent) {
    return getFilePathForTestItem(item.parent);
  }

  return undefined;
};

/**
 * Recursively collect all file paths from a TestItem tree
 */
const collectFilesFromItem = (
  item: vscode.TestItem,
  files: string[] = []
): string[] => {
  const data = testItemData.get(item);

  if (data?.type === "file" && data.filePath) {
    if (!files.includes(data.filePath)) {
      return [...files, data.filePath];
    }
    return files;
  }

  // Recurse into children using functional approach
  const childFiles: string[] = [];
  item.children.forEach((child) => {
    childFiles.push(...collectFilesFromItem(child, files));
  });

  return [...files, ...childFiles];
};

/**
 * Find a file TestItem by name in a collection
 */
export const findFileTestItem = (
  collection: vscode.TestItemCollection,
  fileName: string
): vscode.TestItem | undefined => {
  let result: vscode.TestItem | undefined;

  const search = (coll: vscode.TestItemCollection): boolean => {
    let found = false;
    coll.forEach((item) => {
      if (found) return;

      const data = testItemData.get(item);

      if (data?.type === "file" && data?.filePath === fileName) {
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

  search(collection);
  return result;
};

/**
 * Get test files to run based on a test request
 */
export const getTestFilesToRun = (
  request: vscode.TestRunRequest,
  controller: vscode.TestController
): string[] => {
  if (request.include) {
    // Run specific tests - collect unique file paths
    const files: string[] = [];
    for (const item of request.include) {
      const data = testItemData.get(item);

      // If this is a folder (has children but no testItemData), collect all files from it
      if (!data && item.children.size > 0) {
        const folderFiles = collectFilesFromItem(item, []);
        for (const file of folderFiles) {
          if (!files.includes(file)) {
            files.push(file);
          }
        }
      } else {
        // For files, suites, and tests, get the file path by traversing up
        const filePath = getFilePathForTestItem(item);
        if (filePath && !files.includes(filePath)) {
          files.push(filePath);
        }
      }
    }
    return files;
  }

  // Run all tests in the workspace
  const files: string[] = [];
  controller.items.forEach((item) => {
    files.push(...collectFilesFromItem(item, files));
  });

  return files;
};

/**
 * get a test item
 */
export const getTestItem = ({
  testItemMap,
  parent,
  name,
  nesting,
}: {
  testItemMap: Map<string, vscode.TestItem>;
  parent: vscode.TestItem;
  name: string;
  nesting: number;
}): vscode.TestItem | undefined => {
  const testId = createTestId({ parent, name, nesting });

  let testItem = testItemMap.get(testId);

  return testItem;
};

/**
 * Create or get a test item, ensuring it's registered in the map
 */
export const createOrGetTestItem = ({
  controller,
  testItemMap,
  parent,
  name,
  nesting,
  testType,
}: {
  controller: vscode.TestController;
  testItemMap: Map<string, vscode.TestItem>;
  parent: vscode.TestItem;
  name: string;
  nesting: number;
  testType: "suite" | "test";
}): vscode.TestItem => {
  const testId = createTestId({ parent, name, nesting });

  // Check if TestItem already exists
  let testItem = testItemMap.get(testId);

  if (!testItem) {
    // Create new TestItem
    testItem = controller.createTestItem(testId, name, parent.uri);

    // Store metadata
    testItemData.set(testItem, {
      type: testType,
      fullName: name,
      nestingLevel: nesting,
      discovered: true,
    });

    // Add to parent's children
    parent.children.add(testItem);

    // Add to map for quick lookup
    testItemMap.set(testId, testItem);
  }

  return testItem;
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
