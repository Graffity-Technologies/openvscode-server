/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/// <reference path='../../../src/vs/vscode.d.ts'/>

import ClientOAuth2 from 'client-oauth2';
import crypto from 'crypto';
import * as vscode from 'vscode';
import { URLSearchParams, URL } from 'url';
const create = require('pkce').create;

import { GitpodClient, GitpodServer, GitpodServiceImpl } from '@gitpod/gitpod-protocol/lib/gitpod-service';
import { JsonRpcProxyFactory } from '@gitpod/gitpod-protocol/lib/messaging/proxy-factory';
import WebSocket = require('ws');
import ReconnectingWebSocket from 'reconnecting-websocket';
import { ConsoleLogger, listen as doListen } from 'vscode-ws-jsonrpc';

const authCompletePath = '/auth-complete';
const baseURL = 'https://server-vscode-ouath2.staging.gitpod-dev.com';

export const scopes: string[] = [
	'function:getGitpodTokenScopes',
	'function:accessCodeSyncStorage',
	'resource:default'
];

type UsedGitpodFunction = ['getLoggedInUser', 'getGitpodTokenScopes'];
type Union<Tuple extends any[], Union = never> = Tuple[number] | Union;
export type GitpodConnection = Omit<GitpodServiceImpl<GitpodClient, GitpodServer>, 'server'> & {
	server: Pick<GitpodServer, Union<UsedGitpodFunction>>
};

export interface PromiseAdapter<T, U> {
	(
		value: T,
		resolve:
			(value: U | PromiseLike<U>) => void,
		reject:
			(reason: any) => void
	): any;
}

const passthrough = (value: any, resolve: (value?: any) => void) => resolve(value);

/**
 * Return a promise that resolves with the next emitted event, or with some future
 * event as decided by an adapter.
 *
 * If specified, the adapter is a function that will be called with
 * `(event, resolve, reject)`. It will be called once per event until it resolves or
 * rejects.
 *
 * The default adapter is the passthrough function `(value, resolve) => resolve(value)`.
 *
 * @param event the event
 * @param adapter controls resolution of the returned promise
 * @returns a promise that resolves or rejects as specified by the adapter
 */
function promiseFromEvent<T, U>(
	event: vscode.Event<T>,
	adapter: PromiseAdapter<T, U> = passthrough): { promise: Promise<U>, cancel: vscode.EventEmitter<void> } {
	let subscription: vscode.Disposable;
	let cancel = new vscode.EventEmitter<void>();
	return {
		promise: new Promise<U>((resolve, reject) => {
			cancel.event(_ => reject());
			subscription = event((value: T) => {
				try {
					Promise.resolve(adapter(value, resolve, reject))
						.catch(reject);
				} catch (error) {
					reject(error);
				}
			});
		}).then(
			(result: U) => {
				subscription.dispose();
				return result;
			},
			error => {
				subscription.dispose();
				throw error;
			}
		),
		cancel
	};
}

/**
 * Prompts the user to reload VS Code (executes native `workbench.action.reloadWindow`)
*/
function promptToReload(msg?: string): void {
	const action = 'Reload';

	vscode.window.showInformationMessage(msg || `Reload VS Code for the new Settings Sync configuration to take effect.`, action)
		.then(selectedAction => {
			if (selectedAction === action) {
				vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});
}

/**
 * Adds an authenthication provider as a possible provider for code sync.
 * It adds some key configuration to the user settings, so that the user can choose the Gitpod provider when deciding what to use with setting sync.
 * @param remove - indicates whether to add or remove the configuration
 */
export async function addAuthProviderToSettings(remove?: boolean): Promise<void> {
	const syncStoreURL = `${baseURL}/code-sync`;
	const config = vscode.workspace.getConfiguration();
	const newConfig = {
		url: syncStoreURL,
		stableUrl: syncStoreURL,
		insidersUrl: syncStoreURL,
		canSwitch: true,
		authenticationProviders: {
			gitpod: {
				scopes: ['function:accessCodeSyncStorage']
			}
		}
	};

	if (remove) {
		try {
			await config.update('configurationSync.store', undefined, true);
			promptToReload();
		} catch (e) {
			vscode.window.showErrorMessage(`Error setting up code sync config: ${e}`);
		}
		return;
	}

	try {
		const currentConfig = await config.get('configurationSync.store');
		if (JSON.stringify(currentConfig) !== JSON.stringify(newConfig)) {
			await config.update('configurationSync.store', newConfig, true);
			promptToReload();
		}
	} catch (e) {
		vscode.window.showErrorMessage(`Error setting up code sync config: ${e}`);
	}
}

async function createApiWebSocket(accessToken: string): Promise<{ gitpodService: GitpodConnection; pendignWebSocket: Promise<ReconnectingWebSocket>; }> {
	const factory = new JsonRpcProxyFactory<GitpodServer>();
	const gitpodService: GitpodConnection = new GitpodServiceImpl<GitpodClient, GitpodServer>(factory.createProxy()) as any;
	const pendignWebSocket = (async () => {
		class GitpodServerWebSocket extends WebSocket {
			constructor(address: string, protocols?: string | string[]) {
				super(address, protocols, {
					headers: {
						'Origin': baseURL,
						'Authorization': `Bearer ${accessToken}`
					}
				});
			}
		}
		const webSocket = new ReconnectingWebSocket(baseURL.replace('https', 'wss'), undefined, {
			minReconnectionDelay: 1000,
			connectionTimeout: 10000,
			maxRetries: 10,
			debug: false,
			startClosed: false,
			WebSocket: GitpodServerWebSocket
		});
		webSocket.onerror = console.error;
		doListen({
			webSocket,
			logger: new ConsoleLogger(),
			onConnection: connection => factory.listen(connection),
		});
		return webSocket;
	})();

	return { gitpodService, pendignWebSocket };
}


/**
 * Returns a promise that resolves with the current authentication session of the provided access token. This includes the token itself, the scopes, the user's ID and name.
 * @param accessToken the access token used to authenticate the Gitpod WS connection
 * @param scopes the scopes the authentication session must have
 * @returns a promise that resolves with the authentication session
 */
export async function resolveAuthenticationSession(scopes: readonly string[], accessToken: string): Promise<vscode.AuthenticationSession> {
	const { gitpodService, pendignWebSocket } = await createApiWebSocket(accessToken);
	const user = await gitpodService.server.getLoggedInUser();
	(await pendignWebSocket).close();
	return {
		id: 'gitpod.user',
		account: {
			label: user.name!,
			id: user.id
		},
		scopes: scopes,
		accessToken: accessToken
	};
}

/**
 * Checks if a authentication session includes the provided scopes
 * @param session a VS Code authentication session
 * @param scopes scopes to look for
 * @returns a boolean value indicating whether the scopes match or not
 */
function hasScopes(session: vscode.AuthenticationSession, scopes?: readonly string[]): boolean {
	return !scopes || scopes.every(scope => session.scopes.includes(scope));
}

/**
 * @returns all of the scopes accessible for `accessToken`
 */
export async function checkScopes(accessToken: string): Promise<string[]> {
	const { gitpodService, pendignWebSocket } = await createApiWebSocket(accessToken);
	const hash = crypto.createHash('sha256').update(accessToken, 'utf8').digest('hex');
	const scopes = await gitpodService.server.getGitpodTokenScopes(hash);
	(await pendignWebSocket).close();
	return scopes;
}

/**
 * Adds a authenthication provider to the provided extension context
 * @param context the extension context to act upon and the context to which push the authenthication service
 * @param logger a function used for logging outputs
 */
function registerAuth(context: vscode.ExtensionContext, logger: (value: string) => void): void {
	/**
	 * Returns a promise which waits until the secret store `gitpod.authSession` item changes.
	 * @returns a promise that resolves with the authentication session
	 */
	const waitForAuthenticationSession = async (): Promise<vscode.AuthenticationSession> => {
		logger('Waiting for the onchange event');

		// Wait until a session is added to the context's secret store
		const authPromise = promiseFromEvent(context.secrets.onDidChange, (changeEvent: vscode.SecretStorageChangeEvent, resolve, reject): void => {
			if (changeEvent.key !== 'gitpod.authSession') {
				reject('Cancelled');
			} else {
				resolve(changeEvent.key);
			}
		});
		const data: any = await authPromise.promise;

		logger(data.toString());

		logger('Retrieving the session');

		const session: vscode.AuthenticationSession = JSON.parse(await context.secrets.get('gitpod.authSession') || '');
		return session;
	};

	const disposable = vscode.commands.registerCommand('gitpod.auth.remove', () => {
		addAuthProviderToSettings(true);
	});
	context.subscriptions.push(disposable);

	async function createSession(_scopes: string[]): Promise<vscode.AuthenticationSession> {
		const callbackUri = `${vscode.env.uriScheme}://gitpod.gitpod-desktop/complete-gitpod-auth`;
		const gitpodScopes = new Set<string>([
			'function:accessCodeSyncStorage',
			'resource:default'
		]);
		const gitpodFunctions: UsedGitpodFunction = ['getLoggedInUser', 'getGitpodTokenScopes'];

		for (const gitpodFunction of gitpodFunctions) {
			gitpodScopes.add('function:' + gitpodFunction);
		}
		const gitpodAuth = new ClientOAuth2({
			clientId: 'vscode+gitpod',
			accessTokenUri: `${baseURL}/api/oauth/token`,
			authorizationUri: `${baseURL}/api/oauth/authorize`,
			redirectUri: callbackUri,
			scopes: scopes,
		});

		const redirectUri = new URL(gitpodAuth.code.getUri());
		const secureQuery = new URLSearchParams(redirectUri.search);

		const { codeChallenge }: { codeChallenge: string, codeVerifier: string } = create();
		secureQuery.set('code_challenge', codeChallenge);
		secureQuery.set('code_challenge_method', 'S256');

		redirectUri.search = secureQuery.toString();

		const timeoutPromise = new Promise((_: (value: vscode.AuthenticationSession) => void, reject): void => {
			const wait = setTimeout(() => {
				clearTimeout(wait);
				reject('Login timed out.');
			}, 1000 * 60 * 5); // 5 minutes
		});

		const searchParams = new URLSearchParams(redirectUri.search);

		redirectUri.search = searchParams.toString();
		logger(searchParams.toString());
		// Open the authorization URL in the default browser
		const authURI = vscode.Uri.from({ scheme: redirectUri.protocol.slice(0, -1), authority: redirectUri.hostname, path: redirectUri.pathname, query: redirectUri.search.slice(1) });
		logger(`Opening browser at ${authURI.toString(true)}`);
		const opened = await vscode.env.openExternal(authURI);
		if (!opened) {
			const selected = await vscode.window.showErrorMessage(`Couldn't open ${authURI.toString(true)} automatically, please copy and paste it to your browser manually.`, 'Copy', 'Cancel');
			if (selected === 'Copy') {
				vscode.env.clipboard.writeText(authURI.toString(true));
				logger('Copied auth URL');
			}
		}
		return Promise.race([timeoutPromise, await waitForAuthenticationSession()]);
	}

	const onDidChangeSessionsEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	logger('Registering authentication provider...');
	context.subscriptions.push(vscode.authentication.registerAuthenticationProvider('gitpod', 'Gitpod', {
		onDidChangeSessions: onDidChangeSessionsEmitter.event,
		getSessions: async (scopes: string[]) => {
			const sessions: vscode.AuthenticationSession[] = [];
			if (!scopes) {
				return Promise.resolve(sessions);
			}
			sessions.push(JSON.parse(await context.secrets.get('gitpod.authSession') || ''));
			return Promise.resolve(sessions.filter(session => hasScopes(session, scopes)));
		},
		createSession: async (scopes: string[]) => {
			logger('Pushing change emitter');
			context.subscriptions.push(onDidChangeSessionsEmitter);
			logger('Returning create ');
			return createSession(scopes);
		},
		removeSession: async () => {
			await context.secrets.delete('gitpod.authSession');
		},
	}, { supportsMultipleAccounts: false }));
	logger('Pushed auth');
	const enabledSettingsSync = vscode.workspace.getConfiguration().get('configurationSync.store');
	if (enabledSettingsSync === undefined || JSON.stringify(enabledSettingsSync) === '{}') {
		vscode.window.showInformationMessage('Would you like to use Settings Sync with Gitpod?', 'Yes', 'No')
			.then(selectedAction => {
				if (selectedAction === 'Yes') {
					addAuthProviderToSettings();
				}
			});
	}
}

export { authCompletePath, registerAuth };
