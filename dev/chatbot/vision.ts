// turns images in a message into text captions, so every model can understand them, even those without image input.
// the caption is added to the message's content, so it's saved with the message and never needs captioning again.
// models with vision are given recent images themselves instead, with the saved captions standing in for older ones
import { Message } from 'discord.js';
import { Base64ImageSource } from '@anthropic-ai/sdk/resources';

import { anthropicClient } from '..';

const CAPTION_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
const MAX_IMAGES = 4; // per message. any more are ignored
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB, the most an image block allows
const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// a "(url) [image: caption]" line, or "(url) [image]" for one not captioned yet. the caption can span lines, so it ends at a "]" that ends a line
const IMAGE_LINE_RE = /^\((https?:\/\/\S+?)\) \[image(?:: ([\s\S]*?))?\]$/gm;

const captionPrompt = `Describe this image in 1-3 sentences, for someone who can't see it.
Transcribe any text in it verbatim. Only include the description, no preamble.`;

const CAPTION_TIMEOUT = 30_000; // 30 seconds

// a reason an image can't be captioned, worded to show to the model as-is
class UnviewableImageError extends Error {}

// the response body, stopping as soon as it's too big, so a huge file is never downloaded in full
async function readImage(response: Response): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new UnviewableImageError('too large to view');

  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body ?? []) { // throwing mid-loop cancels the rest of the download
    length += chunk.length;
    if (length > MAX_IMAGE_BYTES) throw new UnviewableImageError('too large to view');
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Every image in a message: attachments, plus images in embeds (e.g. a link preview, or a gif from tenor).
 * fetch is where it's downloaded from, and shown is the url the model sees, which it can give to caption_image
 */
function getImages(message: Message): { fetch: string, shown: string, size?: number }[] {
  // signed urls, which expire after about a day. by then the message has usually left the conversation anyway
  const attachments = message.attachments
    .filter((attachment) => attachment.contentType?.startsWith('image'))
    .map((attachment) => ({ fetch: attachment.url, shown: attachment.url, size: attachment.size }));
  // downloaded through discord's proxied copy, so we never fetch from whatever site the link was to. the original url is shorter to show though
  const embeds = message.embeds
    .map((embed) => embed.image ?? embed.thumbnail)
    .filter((image) => !!image?.url)
    .map((image) => ({ fetch: image!.proxyURL ?? image!.url, shown: image!.url }));

  return [...attachments, ...embeds].slice(0, MAX_IMAGES);
}

/**
 * The image at a url, as an image block's source.
 * Throws UnviewableImageError if it's an image that can't be viewed
 */
async function fetchImage(url: string): Promise<Base64ImageSource> {
  // some sites (e.g. wikimedia) refuse requests without a user agent
  const response = await fetch(url, { headers: { 'User-Agent': 'FooBar Discord bot' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Image fetch responded with status ${response.status}`);

  const mediaType = response.headers.get('content-type')?.split(';')[0] ?? '';
  if (!SUPPORTED_TYPES.includes(mediaType)) throw new UnviewableImageError(`unsupported format (${mediaType || 'unknown'}), couldn't be viewed`);

  const data = await readImage(response);
  return { type: 'base64', media_type: mediaType as Base64ImageSource['media_type'], data: data.toString('base64') };
}

/**
 * A short description of the image at a url. If a question is given, the description answers it too.
 * Throws UnviewableImageError if it's an image that can't be viewed
 */
async function captionImage(url: string, question?: string): Promise<string> {
  const source = await fetchImage(url);

  const result = await anthropicClient.messages.create({
    model: CAPTION_MODEL,
    max_tokens: 1024, // room for any reasoning before the caption itself
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source },
        { type: 'text', text: question ? `${captionPrompt}\nAlso answer this about the image: ${question}` : captionPrompt },
      ],
    }],
  }, { timeout: CAPTION_TIMEOUT, maxRetries: 0 }); // the reply waits on this, so give up rather than keep the user waiting

  const caption =result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(' ').trim();
  if (!caption) throw new Error('The caption model returned no text');
  return caption;
}

/**
 * The message's text, with a "(url) [image: ...]" line for each image in it.
 * A failed caption is noted rather than thrown, so it never stops a reply
 */
async function withCaptions(message: Message): Promise<string> {
  const captions = await Promise.all(getImages(message).map(async (image) => {
    // discord says how big attachments are, so those can be skipped without downloading anything
    if (image.size && image.size > MAX_IMAGE_BYTES) return `(${image.shown}) [image: too large to view]`;

    const caption = await captionImage(image.fetch).catch((error) => {
      if (error instanceof UnviewableImageError) return error.message;
      console.error('Failed to caption image:', error);
      return 'couldn\'t be viewed';
    });

    return `(${image.shown}) [image: ${caption}]`;
  }));

  return [message.content, ...captions].filter(Boolean).join('\n');
}

// the message's text, with a "(url) [image]" line for each image in it, for a model that's given the images themselves while the captions are made
function withImagePlaceholders(message: Message): string {
  const lines = getImages(message).map((image) => `(${image.shown}) [image${image.size && image.size > MAX_IMAGE_BYTES ? ': too large to view' : ''}]`);
  return [message.content, ...lines].filter(Boolean).join('\n');
}

/**
 * The images in a saved message's "(url) [image...]" lines, for a model with vision, and the text to go with them,
 * where each line says it's shown instead of giving its caption. One that can't be fetched keeps its caption, or says why if it has none
 */
async function withImages(content: string): Promise<{ text: string, images: Base64ImageSource[] }> {
  const lines = [...content.matchAll(IMAGE_LINE_RE)];
  if (lines.length === 0) return { text: content, images: [] };

  const fetched = await Promise.all(lines.map(([, url]) => fetchImage(url).catch((error) => {
    if (!(error instanceof UnviewableImageError)) console.error('Failed to fetch image:', error);
    return error instanceof UnviewableImageError ? error.message : 'couldn\'t be viewed';
  })));

  const images: Base64ImageSource[] = [];
  let i = 0;
  const text = content.replace(IMAGE_LINE_RE, (line, url, caption) => {
    const image = fetched[i++];
    if (typeof image === 'string') return caption ? line : `(${url}) [image: ${image}]`;
    images.push(image);
    return `(${url}) [image ${images.length}, shown below]`; // numbered, so a message with several can be told apart
  });

  return { text, images };
}

export { captionImage, fetchImage, withCaptions, withImagePlaceholders, withImages };
