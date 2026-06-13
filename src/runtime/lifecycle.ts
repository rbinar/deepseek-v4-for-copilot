import vscode from 'vscode';
import { AuthManager } from '../auth';
import { fetchBalance } from '../balance';
import { EXTERNAL_URLS } from '../consts';
import { t } from '../i18n';
import { logger } from '../logger';
import { DeepSeekChatProvider } from '../provider';
import { getSessionTokens, getSessionRequests } from '../tracker';
import { registerActionUrls } from './actions';
import { registerCommands } from './commands';
import { initializeDiagnostics } from './diagnostics';
import { registerProvider } from './provider';
import { showWelcomeIfNeeded } from './welcome';

let activeProvider: DeepSeekChatProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	await initializeDiagnostics(context);
	registerCommands(context);
	registerActionUrls(context);

	// --- Status Bar Button ---
	const statusBarButton = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100,
	);
	statusBarButton.text = '$(hubot)';
	statusBarButton.tooltip = 'Open DeepSeek Copilot Panel';
	statusBarButton.command = 'deepseek-copilot.showPanel';
	statusBarButton.show();
	context.subscriptions.push(statusBarButton);

	context.subscriptions.push(
		vscode.commands.registerCommand('deepseek-copilot.showPanel', () => {
			void vscode.commands.executeCommand('deepseek-copilot.panelView.focus');
		}),
	);

	// --- Panel Webview ---
	const authManager = new AuthManager(context);
	const panelProvider = new (class implements vscode.WebviewViewProvider {
		resolveWebviewView(webviewView: vscode.WebviewView): void {
			webviewView.webview.options = { enableScripts: true };

			webviewView.webview.onDidReceiveMessage(async (msg) => {
				if (msg === 'refreshBalance') {
					const key = await authManager.getApiKey();
					if (!key) {
						webviewView.webview.postMessage({ type: 'balance', data: null, error: 'No API key configured' });
						return;
					}
					const balance = await fetchBalance(key);
					webviewView.webview.postMessage({ type: 'balance', data: balance, error: null });
				}
				if (msg === 'getTokens') {
					const tokens = getSessionTokens();
					webviewView.webview.postMessage({ type: 'tokens', data: tokens });
				}
				if (msg === 'getRequests') {
					const reqs = getSessionRequests();
					webviewView.webview.postMessage({ type: 'requests', data: reqs });
				}
				if (msg.type === 'openUrl' && msg.url) {
					void vscode.env.openExternal(vscode.Uri.parse(msg.url));
				}
			});

			webviewView.webview.html = getPanelHtml(context.extension.packageJSON.version);

			// Auto-fetch on load
			void (async () => {
				const key = await authManager.getApiKey();
				if (!key) {
					webviewView.webview.postMessage({ type: 'balance', data: null, error: 'No API key configured' });
				} else {
					const balance = await fetchBalance(key);
					webviewView.webview.postMessage({ type: 'balance', data: balance, error: null });
				}
				webviewView.webview.postMessage({ type: 'tokens', data: getSessionTokens() });
				webviewView.webview.postMessage({ type: 'requests', data: getSessionRequests() });
			})();
		}
	})();

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('deepseek-copilot.panelView', panelProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);

	try {
		const provider = await registerProvider(context);
		activeProvider = provider;

		void showWelcomeIfNeeded(context, provider).catch((error) => {
			logger.warn(t('extension.welcomeFailed'), error);
		});

		logger.info(`Extension activated version=${context.extension.packageJSON.version}`);
	} catch (error) {
		activeProvider = undefined;
		logger.error('Failed to activate DeepSeek extension', error);
		void vscode.window.showErrorMessage(t('extension.activateFailed'));
		throw error;
	}
}

export async function deactivate(): Promise<void> {
	try {
		await activeProvider?.prepareForDeactivate();
	} catch (error) {
		logger.warn(t('extension.deactivateFailed'), error);
	} finally {
		activeProvider = undefined;
		logger.info('Extension deactivated');
		logger.dispose();
	}
}

function getPanelHtml(version: string): string {
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			padding: 16px;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
		}
		h3 { margin-bottom: 12px; font-size: 16px; font-weight: 600; }
		.card {
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 6px;
			padding: 12px;
			margin-bottom: 10px;
		}
		.card label { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
		.card .value { font-size: 13px; }
		.card .value.balance { font-size: 16px; font-weight: 600; color: var(--vscode-charts-green); }
		.card .value.balance.low { color: var(--vscode-charts-orange); }
		.card .value.balance.empty { color: var(--vscode-errorForeground); }
		button {
			margin-top: 6px;
			padding: 5px 12px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 3px;
			cursor: pointer;
			font-family: var(--vscode-font-family);
			font-size: 12px;
		}
		button:hover { background: var(--vscode-button-hoverBackground); }
		button.link {
			background: none;
			color: var(--vscode-textLink-foreground);
			padding: 0;
			margin: 0 8px 0 0;
			font-size: 12px;
			text-decoration: underline;
		}
		button.link:hover { background: none; color: var(--vscode-textLink-activeForeground); }
		#balanceError { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 4px; }
		#tokenValue { font-family: var(--vscode-editor-font-family); font-size: 12px; cursor: pointer; }
		#tokenValue:hover { color: var(--vscode-textLink-foreground); }
		#costValue { font-size: 12px; color: var(--vscode-charts-orange); margin-top: 4px; }
		#requestsTable { display: none; margin-top: 8px; }
		#requestsTable table { width: 100%; border-collapse: collapse; font-size: 11px; }
		#requestsTable th { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-weight: 500; }
		#requestsTable td { padding: 3px 6px; border-bottom: 1px solid var(--vscode-panel-border); font-family: var(--vscode-editor-font-family); }
		#requestsTable tr:hover td { background: var(--vscode-list-hoverBackground); }
		.footer { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 12px; text-align: center; }
	</style>
</head>
<body>
	<div class="card">
		<label>Balance <button onclick="refresh()" style="float:right;margin-top:-5px">Refresh</button></label>
		<div id="balanceValue" class="value">Loading...</div>
		<div id="balanceError"></div>
	</div>
	<div class="card">
		<label>Session Tokens</label>
		<div id="tokenValue" class="value" onclick="toggleRequests()" title="Click for per-request detail">Loading...</div>
		<div id="costValue"></div>
		<div id="requestsTable"></div>
	</div>
	<div class="card">
		<label>Links</label>
		<div>
			<button class="link" onclick="openUrl('${EXTERNAL_URLS.deepseek.apiKeys}')">API Keys</button>
			<button class="link" onclick="openUrl('${EXTERNAL_URLS.deepseek.usage}')">Usage</button>
			<button class="link" onclick="openUrl('${EXTERNAL_URLS.deepseek.status}')">Status</button>
		</div>
	</div>
	<div class="footer">DeepSeek V4 for Copilot · v${version}</div>
	<script>
		const vscode = acquireVsCodeApi();
		let requestsExpanded = false;
		let lastRequests = [];

		function toggleRequests() {
			requestsExpanded = !requestsExpanded;
			renderRequests(lastRequests);
		}

		function refresh() {
			document.getElementById('balanceValue').textContent = 'Loading...';
			document.getElementById('balanceError').textContent = '';
			vscode.postMessage('refreshBalance');
			vscode.postMessage('getTokens');
			vscode.postMessage('getRequests');
		}
		function openUrl(url) { vscode.postMessage({ type: 'openUrl', url }); }

		function renderRequests(reqs) {
			lastRequests = reqs;
			const table = document.getElementById('requestsTable');
			if (!reqs || reqs.length === 0 || !requestsExpanded) {
				table.style.display = 'none';
				table.innerHTML = '';
				return;
			}
			table.style.display = 'block';
			let html = '<table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cost</th></tr></thead><tbody>';
			for (let i = reqs.length - 1; i >= 0; i--) {
				const r = reqs[i];
				html += '<tr>';
				html += '<td>' + esc(r.modelName) + '</td>';
				html += '<td>' + r.inputTokens.toLocaleString() + '</td>';
				html += '<td>' + r.outputTokens.toLocaleString() + '</td>';
				html += '<td>$' + r.costUsd.toFixed(4) + '</td>';
				html += '</tr>';
			}
			html += '</tbody></table>';
			table.innerHTML = html;
		}

		function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

		window.addEventListener('message', e => {
			const msg = e.data;
			if (msg.type === 'balance') {
				const el = document.getElementById('balanceValue');
				const errEl = document.getElementById('balanceError');
				if (msg.error) {
					el.textContent = '—';
					el.className = 'value';
					errEl.textContent = msg.error;
					return;
				}
				if (!msg.data || !msg.data.balance_infos || msg.data.balance_infos.length === 0) {
					el.textContent = 'No balance data';
					el.className = 'value';
					return;
				}
				const infos = msg.data.balance_infos;
				let html = '';
				for (const info of infos) {
					const total = parseFloat(info.total_balance);
					const granted = parseFloat(info.granted_balance);
					const toppedUp = parseFloat(info.topped_up_balance);
					let cls = 'balance';
					if (total <= 0) cls += ' empty';
					else if (total < 1) cls += ' low';
					html += '<div style="margin-bottom:8px">';
					html += '<div class="value ' + cls + '">' + info.currency + ' ' + total.toFixed(2) + '</div>';
					html += '<div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px">';
					html += 'Granted: ' + granted.toFixed(2) + ' · Topped up: ' + toppedUp.toFixed(2);
					html += '</div>';
					html += '</div>';
				}
				el.innerHTML = html;
				errEl.textContent = '';
			}
			if (msg.type === 'tokens') {
				const el = document.getElementById('tokenValue');
				const costEl = document.getElementById('costValue');
				if (!msg.data || msg.data.requestCount === 0) {
					el.textContent = 'No requests yet';
					costEl.textContent = '';
					return;
				}
				const t = msg.data;
				const total = t.inputTokens + t.outputTokens;
				el.innerHTML = t.inputTokens.toLocaleString() + ' in · ' + t.outputTokens.toLocaleString() + ' out · <b>' + total.toLocaleString() + '</b> total (' + t.requestCount + ' requests)';
				if (t.costUsd > 0) {
					costEl.textContent = 'Est. cost: ~$' + t.costUsd.toFixed(4);
				} else {
					costEl.textContent = '';
				}
			}
			if (msg.type === 'requests') {
				renderRequests(msg.data);
			}
		});
		vscode.postMessage('getTokens');
		vscode.postMessage('getRequests');
	</script>
</body>
</html>`;
}
