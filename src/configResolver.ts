import * as vscode from "vscode";
import { minimatch } from "minimatch";
import * as path from "path";

/**
 * Configuration for a single beartest execution pattern
 */
export interface BeartestConfiguration {
  /** Glob pattern to match test file paths (e.g., "packages/frontend/**") */
  pattern: string;
  /** Command to execute tests (e.g., 'node', 'tsx', 'bun') */
  command: string;
  /** Additional arguments passed to the runtime before the test script */
  runtimeArgs: string[];
  /** Optional working directory override (relative to workspace root) */
  cwd?: string;
}

/**
 * Resolved configuration for a test file
 */
export interface ResolvedTestConfig {
  command: string;
  runtimeArgs: string[];
  cwd: string;
  workspaceFolder: vscode.WorkspaceFolder;
  /** The pattern that matched this file (for debugging/grouping) */
  matchedPattern: string;
}

/**
 * Loads beartest configurations from VSCode settings
 */
export const loadConfigurations = (): BeartestConfiguration[] => {
  const config = vscode.workspace.getConfiguration("beartest");
  const configurations = config.get<BeartestConfiguration[]>("configurations", []);

  // If no configurations are defined, return the default
  if (configurations.length === 0) {
    return [{
      pattern: "**/*.test.*",
      command: "node",
      runtimeArgs: []
    }];
  }

  // Validate and normalize configurations
  const normalizedConfigs: BeartestConfiguration[] = [];
  for (const cfg of configurations) {
    if (!cfg.pattern || typeof cfg.pattern !== "string") {
      throw new Error("Each beartest configuration must have a 'pattern' string");
    }
    if (!cfg.command || typeof cfg.command !== "string") {
      throw new Error(
        `Configuration with pattern '${cfg.pattern}' must have a 'command' string`
      );
    }

    // Normalize the configuration
    normalizedConfigs.push({
      pattern: cfg.pattern,
      command: cfg.command,
      runtimeArgs: Array.isArray(cfg.runtimeArgs) ? cfg.runtimeArgs : [],
      cwd: cfg.cwd
    });
  }

  return normalizedConfigs;
};

/**
 * Resolves configuration for a specific test file path
 * @throws Error if no configuration matches the file
 */
export const resolveConfigForFile = (
  filePath: string,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  configurations: BeartestConfiguration[]
): ResolvedTestConfig => {
  // Find which workspace folder this file belongs to
  const workspaceFolder = workspaceFolders.find((folder) =>
    filePath.startsWith(folder.uri.fsPath)
  );

  if (!workspaceFolder) {
    throw new Error(
      `Test file ${filePath} is not within any workspace folder`
    );
  }

  // Make the file path relative to the workspace folder for pattern matching
  const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);

  // Find the first matching configuration
  for (const cfg of configurations) {
    // Use minimatch for glob pattern matching
    // Use forward slashes for cross-platform compatibility
    const normalizedPath = relativePath.split(path.sep).join("/");

    if (minimatch(normalizedPath, cfg.pattern, { dot: true })) {
      // Resolve cwd
      const cwd = cfg.cwd
        ? path.resolve(workspaceFolder.uri.fsPath, cfg.cwd)
        : workspaceFolder.uri.fsPath;

      return {
        command: cfg.command,
        runtimeArgs: [...cfg.runtimeArgs], // Clone to avoid mutation
        cwd,
        workspaceFolder,
        matchedPattern: cfg.pattern,
      };
    }
  }

  // No pattern matched - throw error as per requirements
  throw new Error(
    `No beartest configuration matches test file: ${filePath}\n` +
      `Relative path: ${relativePath}\n` +
      `Available patterns: ${configurations.map((c) => c.pattern).join(", ")}\n\n` +
      `Please add a configuration in your VSCode settings that matches this test file.`
  );
};

/**
 * Groups test files by their resolved configuration
 * Returns a map where key is a unique config identifier
 */
export const groupFilesByConfig = (
  testFiles: string[],
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  configurations: BeartestConfiguration[]
): Map<string, { config: ResolvedTestConfig; files: string[] }> => {
  const groups = new Map<
    string,
    { config: ResolvedTestConfig; files: string[] }
  >();

  for (const file of testFiles) {
    try {
      const config = resolveConfigForFile(file, workspaceFolders, configurations);

      // Create a unique key for this configuration
      // Use pattern + command + runtimeArgs + cwd for grouping
      const configKey = JSON.stringify({
        pattern: config.matchedPattern,
        command: config.command,
        runtimeArgs: config.runtimeArgs,
        cwd: config.cwd,
      });

      if (!groups.has(configKey)) {
        groups.set(configKey, { config, files: [] });
      }

      groups.get(configKey)!.files.push(file);
    } catch (error) {
      // Re-throw with context about which file failed
      throw new Error(
        `Failed to resolve configuration for ${file}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return groups;
};
