import * as vscode from "vscode";
import * as path from "path";
import { testItemData } from "./types";

interface TestDiscovery {
  dispose: () => void;
}

/**
 * Create a TestItem for a test file, including parent folder items
 */
const createFileTestItem = (
  fileUri: vscode.Uri,
  controller: vscode.TestController,
  workspaceFolder: vscode.WorkspaceFolder
): vscode.TestItem => {
  const relativePath = path.relative(
    workspaceFolder.uri.fsPath,
    fileUri.fsPath
  );
  const pathParts = relativePath.split(path.sep);

  // Build folder hierarchy
  let currentCollection = controller.items;
  let currentPath = workspaceFolder.uri.fsPath;

  // Create folder TestItems for each directory in the path
  for (let i = 0; i < pathParts.length - 1; i++) {
    const folderName = pathParts[i];
    currentPath = path.join(currentPath, folderName);
    const folderId = `folder:${currentPath}`;

    let folderItem = currentCollection.get(folderId);
    if (!folderItem) {
      folderItem = controller.createTestItem(
        folderId,
        folderName,
        vscode.Uri.file(currentPath)
      );
      currentCollection.add(folderItem);
    }

    currentCollection = folderItem.children;
  }

  // Create the file TestItem
  const fileName = pathParts[pathParts.length - 1];
  const fileId = `file:${fileUri.fsPath}`;

  let fileItem = currentCollection.get(fileId);
  if (!fileItem) {
    fileItem = controller.createTestItem(fileId, fileName, fileUri);

    // Store metadata for this file item
    testItemData.set(fileItem, {
      type: "file",
      filePath: fileUri.fsPath,
      fullName: fileName,
      nestingLevel: 0,
      discovered: true,
    });

    currentCollection.add(fileItem);
  }

  return fileItem;
};

/**
 * Delete a TestItem for a removed test file
 */
const deleteFileTestItem = (
  fileUri: vscode.Uri,
  controller: vscode.TestController,
  workspaceFolder: vscode.WorkspaceFolder
): void => {
  const fileId = `file:${fileUri.fsPath}`;
  const relativePath = path.relative(
    workspaceFolder.uri.fsPath,
    fileUri.fsPath
  );
  const pathParts = relativePath.split(path.sep);

  // Navigate to the file's parent collection
  let currentCollection = controller.items;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const folderPath = path.join(
      workspaceFolder.uri.fsPath,
      ...pathParts.slice(0, i + 1)
    );
    const folderId = `folder:${folderPath}`;
    const folderItem = currentCollection.get(folderId);

    if (!folderItem) {
      return; // Path doesn't exist
    }

    currentCollection = folderItem.children;
  }

  // Delete the file item
  currentCollection.delete(fileId);

  // Clean up empty parent folders
  cleanupEmptyFolders(fileUri, controller, workspaceFolder);
};

/**
 * Remove empty folder TestItems after a file is deleted
 */
const cleanupEmptyFolders = (
  fileUri: vscode.Uri,
  controller: vscode.TestController,
  workspaceFolder: vscode.WorkspaceFolder
): void => {
  const relativePath = path.relative(
    workspaceFolder.uri.fsPath,
    fileUri.fsPath
  );
  const pathParts = relativePath.split(path.sep);

  // Work backwards from the parent folder
  for (let i = pathParts.length - 2; i >= 0; i--) {
    const folderPath = path.join(
      workspaceFolder.uri.fsPath,
      ...pathParts.slice(0, i + 1)
    );
    const folderId = `folder:${folderPath}`;

    // Find the folder item
    let currentCollection = controller.items;
    let folderItem: vscode.TestItem | undefined;

    for (let j = 0; j <= i; j++) {
      const checkPath = path.join(
        workspaceFolder.uri.fsPath,
        ...pathParts.slice(0, j + 1)
      );
      const checkId = `folder:${checkPath}`;
      folderItem = currentCollection.get(checkId);

      if (!folderItem) {
        break;
      }

      if (j < i) {
        currentCollection = folderItem.children;
      }
    }

    // If folder is empty, delete it
    if (folderItem && folderItem.children.size === 0) {
      currentCollection.delete(folderId);
    } else {
      // Stop if we found a non-empty folder
      break;
    }
  }
};

/**
 * Initialize test discovery for a workspace folder
 * Returns a disposable object
 */
export const createTestDiscovery = async (
  controller: vscode.TestController,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<TestDiscovery> => {
  // Get test file patterns from configuration
  const patterns = vscode.workspace
    .getConfiguration("beartest")
    .get<string[]>("testFilePattern", ["**/*.test.*"]);

  // Discover existing test files for all patterns
  const fileUriSet = new Set<string>();
  for (const pattern of patterns) {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceFolder, pattern),
      "**/node_modules/**"
    );
    for (const fileUri of files) {
      fileUriSet.add(fileUri.fsPath);
    }
  }

  // Create test items for unique files
  for (const filePath of fileUriSet) {
    createFileTestItem(vscode.Uri.file(filePath), controller, workspaceFolder);
  }

  // Set up file system watchers for all patterns
  const fileWatchers = patterns.map((pattern) => {
    const globPattern = new vscode.RelativePattern(workspaceFolder, pattern);
    const watcher = vscode.workspace.createFileSystemWatcher(globPattern);

    watcher.onDidCreate((uri) => {
      createFileTestItem(uri, controller, workspaceFolder);
    });

    watcher.onDidDelete((uri) => {
      deleteFileTestItem(uri, controller, workspaceFolder);
    });

    return watcher;
  });

  // Return disposable object
  return {
    dispose: () => {
      fileWatchers.forEach((watcher) => watcher.dispose());
    },
  };
};
