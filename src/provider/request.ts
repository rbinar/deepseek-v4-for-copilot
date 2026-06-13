import vscode from 'vscode';
import { AuthManager } from '../auth';
import { DeepSeekClient } from '../client';
import { getApiModelId, getBaseUrl, getMaxTokens } from '../config';
import { MODELS } from '../consts';
import { isOfficialDeepSeekBaseUrl } from '../endpoint';
import { t } from '../i18n';
import { getCurrentCopilotSession } from '../session';
import type { DeepSeekRequest } from '../types';
import { convertMessages, countMessageChars } from './convert';
import {
    dumpDeepSeekRequest,
    type CacheDiagnosticsRecorder,
    type CacheDiagnosticsRun,
} from './debug';
import {
	getConfiguredContextSize,
	getConfiguredThinkingEffort,
	type ContextSize,
	type ModelConfigurationOptions,
	type ThinkingEffort,
} from './models';
import type { ReplayMarkerMetadata } from './replay';
import { classifyDeepSeekRequest, shouldForceThinkingNone, type RequestKind } from './routing';
import type { ConversationSegment } from './segment';
import { toDeepSeekNativeReasoningRequest } from './thinking';
import { collectTrailingToolResultIds, prepareRequestTools } from './tools/request';
import { resolveImageMessages, type VisionDescriber } from './vision';

function extractRawText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
	// Concatenate all user message text for debug display (first 500 chars).
	let raw = '';
	for (const msg of messages) {
		if (msg.role !== vscode.LanguageModelChatMessageRole.User) continue;
		if (typeof msg.content === 'string') {
			raw += msg.content + '\n---\n';
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part && typeof (part as { value?: unknown }).value === 'string') {
					raw += (part as { value: string }).value + '\n---\n';
				}
			}
		}
	}
	return raw;
}

function extractSessionTitle(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
	// Collect text from user messages, joining all text parts per message.
	let fullText = '';
	for (const msg of messages) {
		if (msg.role !== vscode.LanguageModelChatMessageRole.User) continue;
		if (typeof msg.content === 'string') {
			fullText += msg.content + '\n';
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part && typeof (part as { value?: unknown }).value === 'string') {
					fullText += (part as { value: string }).value + '\n';
				}
			}
		}
	}

	// 1) <userRequest> is THE user message — always prefer it.
	const urMatch = fullText.match(/<userRequest[\s\S]*?<\/userRequest>/gi);
	if (urMatch) {
		for (const block of urMatch) {
			const inner = block.replace(/<\/?userRequest[^>]*>/gi, '').trim();
			if (inner.length >= 3) {
				const clean = inner.replace(/[#*_`~]/g, '').trim().slice(0, 60);
				if (clean) return clean;
			}
		}
	}

	// 2) Fallback: search the rest of the text after stripping system blocks.
	let cleaned = fullText
		.replace(/<environment_info[\s\S]*?<\/environment_info>/gi, '')
		.replace(/<workspace_info[\s\S]*?<\/workspace_info>/gi, '')
		.replace(/<instructions[\s\S]*?<\/instructions>/gi, '')
		.replace(/<reminderInstructions[\s\S]*?<\/reminderInstructions>/gi, '')
		.replace(/<user_info[\s\S]*?<\/user_info>/gi, '')
		.replace(/<rules[\s\S]*?<\/rules>/gi, '')
		.replace(/<memory[\s\S]*?<\/memory>/gi, '')
		.replace(/<todoList[\s\S]*?<\/todoList>/gi, '')
		.replace(/<attachments[\s\S]*?<\/attachments>/gi, '')
		.replace(/<attachment[\s\S]*?<\/attachment>/gi, '')
		.replace(/<context>[\s\S]*?<\/context>/gi, '')
		.replace(/<userRequest[\s\S]*?<\/userRequest>/gi, '')
		.replace(/<userMemory>[\s\S]*?<\/userMemory>/gi, '')
		.replace(/<repoMemory>[\s\S]*?<\/repoMemory>/gi, '')
		.replace(/<sessionMemory>[\s\S]*?<\/sessionMemory>/gi, '')
		.replace(/<[^>]*>/g, ' ');

	const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l.length >= 3);
	// Take the last non-system line (usually closest to the user's actual words).
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (/^(You are |The user|The current|Information about|#{1,6}\s)/.test(line)) continue;
		const title = line.replace(/[#*_`~]/g, '').trim().slice(0, 60);
		if (title) return title;
	}

	return 'Untitled';
}

export interface PreparedChatRequest {
	client: DeepSeekClient;
	baseUrl: string;
	globalStorageUri: vscode.Uri;
	request: DeepSeekRequest;
	/** The VS Code model ID (e.g. "deepseek-v4-pro"). */
	modelId: string;
	isThinkingModel: boolean;
	thinkingEffort: ThinkingEffort;
	totalRequestChars: number;
	trailingToolResultIds: string[];
	cacheDiagnostics: CacheDiagnosticsRun;
	requestKind: RequestKind;
	segment: ConversationSegment;
	replayMarkerMetadata: ReplayMarkerMetadata;
	visionMarkerTextChars?: number;
	initialResponseNotice?: string;
	/** The context size selected via the model-picker dropdown (if any). */
	configuredContextSize: ContextSize;
	/** Stable Copilot Chat session ID used for grouping (falls back to title). */
	sessionId: string;
	/** Title from Copilot Chat session, or extracted from user message. */
	sessionTitle: string;
	/** Raw text from user messages (for debug). */
	sessionRawText: string;
}

export interface PrepareChatRequestOptions {
	authManager: AuthManager;
	globalStorageUri: vscode.Uri;
	modelInfo: vscode.LanguageModelChatInformation;
	segment: ConversationSegment;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
	token: vscode.CancellationToken;
	cacheDiagnostics: CacheDiagnosticsRecorder;
	getVisionDescriber: () => Promise<VisionDescriber | undefined>;
}

export async function prepareChatRequest({
	authManager,
	globalStorageUri,
	modelInfo,
	segment,
	messages,
	options,
	token,
	cacheDiagnostics,
	getVisionDescriber,
}: PrepareChatRequestOptions): Promise<PreparedChatRequest> {
	const apiKey = await authManager.getApiKey();
	if (!apiKey) {
		throw new Error(t('auth.notConfigured'));
	}

	const baseUrl = getBaseUrl();
	const client = new DeepSeekClient(baseUrl, apiKey);
	const modelDef = MODELS.find((m) => m.id === modelInfo.id);
	const isThinkingModel = modelDef?.capabilities.thinking ?? false;
	const maxTokens = getMaxTokens();

	const visionResolution = await resolveImageMessages(messages, token, getVisionDescriber);
	const resolvedMessages = visionResolution.messages;
	const deepseekMessages = convertMessages(resolvedMessages, isThinkingModel);
	const tools = prepareRequestTools(modelDef?.capabilities.toolCalling, options);

	const totalRequestChars = countMessageChars(deepseekMessages);
	const baseRequest: DeepSeekRequest = {
		model: getApiModelId(modelInfo.id),
		messages: deepseekMessages,
		stream: true,
		tools,
		tool_choice: tools && tools.length > 0 ? ('auto' as const) : undefined,
		max_tokens: maxTokens,
	};
	const requestKind = classifyDeepSeekRequest({
		request: baseRequest,
		inputMessages: messages,
	});
	const configuredThinkingEffort = getConfiguredThinkingEffort(
		options as ModelConfigurationOptions,
	);
	const configuredContextSize = getConfiguredContextSize(options as ModelConfigurationOptions);
	// Only force helper requests into disabled thinking on the official API.
	// Custom endpoints keep their configured effort to preserve pre-#137 request shape.
	const forceNoneThinking =
		shouldForceThinkingNone(requestKind) && isOfficialDeepSeekBaseUrl(baseUrl);
	const thinkingEffort = forceNoneThinking ? 'none' : configuredThinkingEffort;
	const request: DeepSeekRequest = isThinkingModel
		? toDeepSeekNativeReasoningRequest(baseRequest, thinkingEffort)
		: baseRequest;
	dumpDeepSeekRequest(request, {
		globalStorageUri,
		segment,
		requestKind,
		vscodeModelId: modelInfo.id,
		isThinkingModel,
		thinkingEffort,
		maxTokens,
		inputMessages: messages,
		resolvedMessages,
		requestOptions: options,
		visionModelId: visionResolution.visionModelId,
		visionProxySource: visionResolution.visionProxySource,
		visionStats: visionResolution.stats,
	});

	const diagnosticsRun = cacheDiagnostics.beginRequest({
		request,
		segment,
		requestKind,
		vscodeModelId: modelInfo.id,
		isThinkingModel,
		thinkingEffort,
		maxTokens,
		inputMessages: messages,
		resolvedMessages,
		visionModelId: visionResolution.visionModelId,
		visionProxySource: visionResolution.visionProxySource,
		visionStats: visionResolution.stats,
	});

	return {
		client,
		baseUrl,
		globalStorageUri,
		request,
		modelId: modelInfo.id,
		isThinkingModel,
		thinkingEffort,
		totalRequestChars,
		trailingToolResultIds: collectTrailingToolResultIds(deepseekMessages),
		cacheDiagnostics: diagnosticsRun,
		requestKind,
		segment,
		replayMarkerMetadata: visionResolution.replayMarkerMetadata,
		visionMarkerTextChars: visionResolution.stats.markerVisionTextChars || undefined,
		initialResponseNotice: visionResolution.initialResponseNotice,
		configuredContextSize,
		...resolveSessionIdentity(messages),
		sessionRawText: extractRawText(messages),
	};
}

function resolveSessionIdentity(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): { sessionId: string; sessionTitle: string } {
	const copilot = getCurrentCopilotSession();
	if (copilot) {
		const title = copilot.title && copilot.title !== 'New Chat' ? copilot.title : extractSessionTitle(messages);
		return { sessionId: copilot.id, sessionTitle: title };
	}
	const fallbackTitle = extractSessionTitle(messages);
	return { sessionId: fallbackTitle, sessionTitle: fallbackTitle };
}
