import { MODELS } from './consts';
import type { DeepSeekUsage, ModelDefinition } from './types';

/**
 * Lightweight in-memory session token tracker.
 * Accumulates across requests within a single VS Code session.
 */
export interface SessionTokens {
	inputTokens: number;
	outputTokens: number;
	requestCount: number;
	/** Estimated cost in USD based on model pricing. */
	costUsd: number;
}

export interface SessionRequest {
	timestamp: number;
	modelId: string;
	modelName: string;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

const session: SessionTokens = {
	inputTokens: 0,
	outputTokens: 0,
	requestCount: 0,
	costUsd: 0,
};

const requests: SessionRequest[] = [];

// Build pricing lookup from MODELS const
const pricingMap = new Map<string, { inputPerM: number; outputPerM: number }>();
for (const m of MODELS as ModelDefinition[]) {
	const usd = m.pricing?.USD;
	if (usd) {
		pricingMap.set(m.id, { inputPerM: usd.cacheMissInput, outputPerM: usd.output });
	}
}

function calcCost(inputTokens: number, outputTokens: number, modelId: string): number {
	const p = pricingMap.get(modelId);
	if (!p) return 0;
	return (inputTokens / 1_000_000) * p.inputPerM + (outputTokens / 1_000_000) * p.outputPerM;
}

function findModelName(modelId: string): string {
	const m = (MODELS as ModelDefinition[]).find(m => m.id === modelId);
	return m?.name ?? modelId;
}

export function recordUsage(usage: DeepSeekUsage, modelId?: string): void {
	const input = usage.prompt_tokens ?? 0;
	const output = usage.completion_tokens ?? 0;
	const cost = modelId ? calcCost(input, output, modelId) : 0;

	session.inputTokens += input;
	session.outputTokens += output;
	session.requestCount += 1;
	session.costUsd += cost;

	requests.push({
		timestamp: Date.now(),
		modelId: modelId ?? 'unknown',
		modelName: findModelName(modelId ?? 'unknown'),
		inputTokens: input,
		outputTokens: output,
		costUsd: cost,
	});
}

export function getSessionTokens(): Readonly<SessionTokens> {
	return session;
}

export function getSessionRequests(): readonly SessionRequest[] {
	return requests;
}
