import * as vscode from 'vscode';
import { createTestDiscovery } from './testDiscovery';
import { createTestProfiles } from './testRunner';

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

  // Set up discovery for each workspace folder
  for (const workspaceFolder of workspaceFolders) {
    const discovery = await createTestDiscovery(controller, workspaceFolder);
    context.subscriptions.push(discovery);
  }

  // Set up test runner profiles
  const { runProfile, debugProfile } = createTestProfiles(controller);
  context.subscriptions.push(runProfile, debugProfile);

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
