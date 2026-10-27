// OpenRouter's model list, for choosing a chatbot's model and knowing what it supports.
// it's ~800kb, too slow to fetch on every autocomplete keystroke, so it's kept in memory and refreshed hourly

const MODELS_URL = 'https://openrouter.ai/api/v1/models'; // public, no key needed
const REFRESH_INTERVAL = 60 * 60_000; // 1 hour

// used whenever a chatbot hasn't picked a model, effort, or temperature
const DEFAULT_MODEL = 'z-ai/glm-5.3';
const DEFAULT_REASONING_EFFORT = 'medium';
const DEFAULT_TEMPERATURE = 1.0;
const MAX_TEMPERATURE = 2; // the most OpenRouter takes

// models whose provider caps it lower, by id prefix. the full range is used everywhere else
const TEMPERATURE_LIMITS: [prefix: string, max: number][] = [['anthropic/', 1]];

// every effort level OpenRouter uses, lowest to highest. each model supports only some of them
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

interface OpenRouterModel {
  id: string,
  name: string,
  context_length: number,
  pricing: { prompt: string, completion: string }, // usd per token, as strings
  supported_parameters?: string[],
  reasoning?: { supported_efforts?: string[], default_effort?: string },
  architecture?: { input_modalities?: string[] }, // e.g. ['text', 'image']
}

let models: OpenRouterModel[] = [];
let lastLoaded = 0;
let loading: Promise<void> | undefined;

// fetches the list, keeping the old one if it fails, so a hiccup at OpenRouter doesn't empty it
async function loadModels(): Promise<void> {
  loading ??= (async () => {
    try {
      const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`OpenRouter responded with status ${response.status}`);

      const data = await response.json();
      models = data.data;
      lastLoaded = Date.now();
    } catch (error) {
      console.error('Failed to load OpenRouter models:', error);
    } finally {
      loading = undefined;
    }
  })();

  return loading;
}

// the cached list. refreshes in the background once it's stale, rather than making the caller wait
function getModels(): OpenRouterModel[] {
  if (Date.now() - lastLoaded > REFRESH_INTERVAL) loadModels();
  return models;
}

function findModel(id: string): OpenRouterModel | undefined {
  return getModels().find((model) => model.id === id);
}

// if the list couldn't be loaded, assume yes, since the model was checked when it was chosen
function supportsTools(id: string): boolean {
  const model = findModel(id);
  return !model || !!model.supported_parameters?.includes('tools');
}
// some models ignore it, e.g. reasoning models that fix their own. assumes yes if the list couldn't be loaded, like supportsTools
function supportsTemperature(id: string): boolean {
  const model = findModel(id);
  return !model || !!model.supported_parameters?.includes('temperature');
}

// unlike supportsTools, assumes no if the list couldn't be loaded, since images sent to a model without vision would fail every reply, while captions always work
function supportsImages(id: string): boolean {
  return !!findModel(id)?.architecture?.input_modalities?.includes('image');
}

// the most temperature a model takes, so a setting above it can't make every reply fail
function maxTemperature(id: string): number {
  return TEMPERATURE_LIMITS.find(([prefix]) => id.startsWith(prefix))?.[1] ?? MAX_TEMPERATURE;
}
function temperatureFor(id: string, temperature: number): number {
  return Math.min(temperature, maxTemperature(id));
}

/**
 * The effort levels a model supports, lowest to highest.
 * Every level if the model doesn't say (or the list couldn't be loaded), and none if it can't reason at all
 */
function getSupportedEfforts(id: string): string[] {
  const model = findModel(id);
  if (!model) return REASONING_EFFORTS;
  if (!model.supported_parameters?.includes('reasoning')) return [];

  const supported = model.reasoning?.supported_efforts;
  return supported ? REASONING_EFFORTS.filter((effort) => supported.includes(effort)) : REASONING_EFFORTS;
}

// e.g. "$0.08/$3.20 per M": usd per million input/output tokens
function formatPricing(model: OpenRouterModel): string {
  const perMillion = (price: string) => `$${(Number(price) * 1_000_000).toFixed(2)}`;
  return `${perMillion(model.pricing.prompt)}/${perMillion(model.pricing.completion)} per M`;
}

export { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, DEFAULT_TEMPERATURE, MAX_TEMPERATURE, REASONING_EFFORTS, OpenRouterModel, loadModels, getModels, findModel, supportsTools, supportsImages, supportsTemperature, maxTemperature, temperatureFor, getSupportedEfforts, formatPricing };
