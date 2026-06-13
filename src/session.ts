/**
 * Reads Copilot Chat session titles from VS Code's globalState database.
 * This is a lightweight approach — we shell out to sqlite3 (available on macOS).
 * Falls back to undefined if the DB can't be read.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import vscode from 'vscode';

const SESSION_STORE_KEY = 'chat.ChatSessionStore.index';

let cachedDbPath: string | undefined;
let dbPathResolved = false;
let globalStorageUri: vscode.Uri | undefined;
let cachedTitles: Map<string, string> | undefined;
let cacheTime = 0;
const CACHE_TTL = 5000; // 5 seconds

/**
 * Must be called once during activation with the extension context, so we can
 * locate `state.vscdb` (sibling of our own globalStorage folder).
 */
export function initSession(context: vscode.ExtensionContext): void {
	globalStorageUri = context.globalStorageUri;
	// Reset cache so the path is recomputed with the new context.
	cachedDbPath = undefined;
	dbPathResolved = false;
}

function getStateDbPath(): string | undefined {
	if (dbPathResolved) return cachedDbPath;
	dbPathResolved = true;

	// Preferred: our own globalStorageUri is `.../User/globalStorage/<our-id>/`.
	// `state.vscdb` lives one level up in `.../User/globalStorage/`.
	if (globalStorageUri) {
		try {
			const candidate = vscode.Uri.joinPath(globalStorageUri, '..', 'state.vscdb').fsPath;
			if (fs.existsSync(candidate)) {
				cachedDbPath = candidate;
				return cachedDbPath;
			}
		} catch {
			// fall through to other strategies
		}
	}

	// Fallback: try common absolute paths for both VS Code variants.
	try {
		const home = process.env.HOME || '~';
		const paths = [
			`${home}/Library/Application Support/Code - Insiders/User/globalStorage/state.vscdb`,
			`${home}/Library/Application Support/Code/User/globalStorage/state.vscdb`,
		];
		for (const p of paths) {
			if (fs.existsSync(p)) {
				cachedDbPath = p;
				return p;
			}
		}
	} catch {
		// ignore
	}

	cachedDbPath = undefined;
	return undefined;
}

function loadSessionTitles(): Map<string, string> {
	const now = Date.now();
	if (cachedTitles && now - cacheTime < CACHE_TTL) {
		return cachedTitles;
	}

	const dbPath = getStateDbPath();
	if (!dbPath) {
		cachedTitles = new Map();
		return cachedTitles;
	}

	try {
		const raw = execSync(
			`sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = '${SESSION_STORE_KEY}';"`,
			{ timeout: 2000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
		);
		if (!raw) {
			cachedTitles = new Map();
			return cachedTitles;
		}

		const data = JSON.parse(raw) as { entries?: Record<string, { sessionId: string; title: string; lastMessageDate: number; isEmpty?: boolean }> };
		const entries = data.entries ?? {};
		const map = new Map<string, string>();
		for (const [, v] of Object.entries(entries)) {
			if (v.title && v.title !== 'New Chat') {
				map.set(v.sessionId, v.title);
			}
		}
		cachedTitles = map;
		cacheTime = now;
		return map;
	} catch {
		cachedTitles = new Map();
		cacheTime = now;
		return new Map();
	}
}

/**
 * Returns the Copilot Chat session title for the most recently active session,
 * or undefined if unavailable.
 */
export function getCurrentCopilotSessionTitle(): string | undefined {
	return getCurrentCopilotSession()?.title;
}

/**
 * Returns the most recently active Copilot Chat session
 * (both id and title), or undefined if unavailable.
 * Does NOT filter by isEmpty — the freshest session by lastMessageDate wins.
 */
export function getCurrentCopilotSession(): { id: string; title: string } | undefined {
	const dbPath = getStateDbPath();
	if (!dbPath) return undefined;

	try {
		const raw = execSync(
			`sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = '${SESSION_STORE_KEY}';"`,
			{ timeout: 2000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
		);
		if (!raw) return undefined;

		const data = JSON.parse(raw) as { entries?: Record<string, { sessionId: string; title: string; lastMessageDate: number; isEmpty?: boolean }> };
		const entries = Object.values(data.entries ?? {});
		// Find most recent session by lastMessageDate (don't filter isEmpty — the
		// current session may not be marked non-empty yet when our request arrives).
		let best: { sessionId: string; title: string; lastMessageDate: number } | undefined;
		for (const e of entries) {
			if (!best || e.lastMessageDate > best.lastMessageDate) {
				best = e;
			}
		}
		if (best) {
			return { id: best.sessionId, title: best.title || 'Untitled' };
		}
	} catch {
		// ignore
	}
	return undefined;
}

/**
 * Returns all known Copilot session titles mapped by session ID.
 */
export function getAllCopilotSessionTitles(): ReadonlyMap<string, string> {
	return loadSessionTitles();
}
