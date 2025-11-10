import * as vscode from "vscode";
import * as path from "path";
import { testItemData } from "./types";

/**
 * Discovers test files in the workspace and builds the file/folder hierarchy
 */
export class TestDiscovery {
  private fileWatcher: vscode.FileSystemWatcher | undefined;

  constructor(
    private controller: vscode.TestController,
    private workspaceFolder: vscode.WorkspaceFolder
  ) {}

  /**
   * Initialize test discovery by finding all test files and setting up watchers
   */
  async initialize(): Promise<void> {
    // Get test file pattern from configuration
    const pattern = vscode.workspace
      .getConfiguration("beartest")
      .get<string>("testFilePattern", "**/*.test.*");

    // Discover existing test files
    await this.discoverTestFiles(pattern);

    // Watch for file system changes
    this.setupFileWatcher(pattern);
  }

  /**
   * Discover all test files matching the pattern
   */
  private async discoverTestFiles(pattern: string): Promise<void> {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.workspaceFolder, pattern),
      "**/node_modules/**"
    );

    for (const fileUri of files) {
      this.createFileTestItem(fileUri);
    }
  }

  /**
   * Create a TestItem for a test file, including parent folder items
   */
  private createFileTestItem(fileUri: vscode.Uri): vscode.TestItem {
    const relativePath = path.relative(
      this.workspaceFolder.uri.fsPath,
      fileUri.fsPath
    );
    const pathParts = relativePath.split(path.sep);

    // Build folder hierarchy
    let currentCollection = this.controller.items;
    let currentPath = this.workspaceFolder.uri.fsPath;

    // Create folder TestItems for each directory in the path
    for (let i = 0; i < pathParts.length - 1; i++) {
      const folderName = pathParts[i];
      currentPath = path.join(currentPath, folderName);
      const folderId = this.getFolderId(currentPath);

      let folderItem = currentCollection.get(folderId);
      if (!folderItem) {
        folderItem = this.controller.createTestItem(
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
    const fileId = this.getFileId(fileUri.fsPath);

    let fileItem = currentCollection.get(fileId);
    if (!fileItem) {
      fileItem = this.controller.createTestItem(fileId, fileName, fileUri);

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
  }

  /**
   * Set up file system watcher for test file changes
   */
  private setupFileWatcher(pattern: string): void {
    const globPattern = new vscode.RelativePattern(
      this.workspaceFolder,
      pattern
    );
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(globPattern);

    // Handle new test files
    this.fileWatcher.onDidCreate((uri) => {
      this.createFileTestItem(uri);
    });

    // Handle deleted test files
    this.fileWatcher.onDidDelete((uri) => {
      this.deleteFileTestItem(uri);
    });

    // Handle renamed/moved test files (treated as delete + create)
    // VSCode handles this with onDidDelete and onDidCreate events
  }

  /**
   * Delete a TestItem for a removed test file
   */
  private deleteFileTestItem(fileUri: vscode.Uri): void {
    const fileId = this.getFileId(fileUri.fsPath);
    const relativePath = path.relative(
      this.workspaceFolder.uri.fsPath,
      fileUri.fsPath
    );
    const pathParts = relativePath.split(path.sep);

    // Navigate to the file's parent collection
    let currentCollection = this.controller.items;
    for (let i = 0; i < pathParts.length - 1; i++) {
      const folderName = pathParts[i];
      const folderPath = path.join(
        this.workspaceFolder.uri.fsPath,
        ...pathParts.slice(0, i + 1)
      );
      const folderId = this.getFolderId(folderPath);
      const folderItem = currentCollection.get(folderId);

      if (!folderItem) {
        return; // Path doesn't exist
      }

      currentCollection = folderItem.children;
    }

    // Delete the file item
    currentCollection.delete(fileId);

    // Clean up empty parent folders
    this.cleanupEmptyFolders(fileUri);
  }

  /**
   * Remove empty folder TestItems after a file is deleted
   */
  private cleanupEmptyFolders(fileUri: vscode.Uri): void {
    const relativePath = path.relative(
      this.workspaceFolder.uri.fsPath,
      fileUri.fsPath
    );
    const pathParts = relativePath.split(path.sep);

    // Work backwards from the parent folder
    for (let i = pathParts.length - 2; i >= 0; i--) {
      const folderPath = path.join(
        this.workspaceFolder.uri.fsPath,
        ...pathParts.slice(0, i + 1)
      );
      const folderId = this.getFolderId(folderPath);

      // Find the folder item
      let currentCollection = this.controller.items;
      let folderItem: vscode.TestItem | undefined;

      for (let j = 0; j <= i; j++) {
        const checkPath = path.join(
          this.workspaceFolder.uri.fsPath,
          ...pathParts.slice(0, j + 1)
        );
        const checkId = this.getFolderId(checkPath);
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
  }

  /**
   * Generate a unique ID for a folder
   */
  private getFolderId(folderPath: string): string {
    return `folder:${folderPath}`;
  }

  /**
   * Generate a unique ID for a file
   */
  private getFileId(filePath: string): string {
    return `file:${filePath}`;
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.fileWatcher?.dispose();
  }
}
