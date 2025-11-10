import * as vscode from 'vscode';
import { TestDiscovery } from './testDiscovery';
import { TestRunner } from './testRunner';

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Create the test controller
  const controller = vscode.tests.createTestController(
    'beartestTestController',
    'Beartest'
  );

  context.subscriptions.push(controller);

  // Initialize test discovery for each workspace folder
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('No workspace folder found for Beartest extension');
    return;
  }

  // Set up discovery and runner for the workspace
  const discoveries: TestDiscovery[] = [];

  for (const workspaceFolder of workspaceFolders) {
    const discovery = new TestDiscovery(controller, workspaceFolder);
    await discovery.initialize();
    discoveries.push(discovery);
    context.subscriptions.push(discovery);
  }

  // Set up test runner
  const runner = new TestRunner(controller);

  // Create run profile
  const runProfile = runner.createRunProfile();
  context.subscriptions.push(runProfile);

  // Create debug profile
  const debugProfile = runner.createDebugProfile();
  context.subscriptions.push(debugProfile);

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('beartest')) {
        // Refresh test discovery when configuration changes
        vscode.window.showInformationMessage(
          'Beartest configuration changed. Please reload the window to apply changes.'
        );
      }
    })
  );

  console.log('Beartest Test Explorer extension activated');
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  console.log('Beartest Test Explorer extension deactivated');
}
