// files sent in messages, other than images (see vision.ts). each is downloaded once, when its message is saved:
// - readable text up to MAX_FILE_WORDS, and PDFs up to MAX_FILE_BYTES, get a "(url) [file: name, size]" line, and are kept in
//   the database (ConversationFile), to attach to the latest messages' turns each reply, like images. older ones are left as the line
// - anything bigger, or unreadable, is downloaded into the sandbox's downloads folder instead, for the bot to work with there.
//   without a sandbox to save to, a long text file is cut short, and anything else is only named
import { Message } from 'discord.js';

import { ConversationFileTable } from '../types/schema';
import { sandboxExec } from './sandbox';

const MAX_FILES = 4; // per message. any more are ignored
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB, the most downloaded here to read or attach
const MAX_FILE_WORDS = 10_000; // a text file longer than this is saved to the sandbox instead
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100MB, the most saved to the sandbox
const DOWNLOAD_DIR = 'downloads'; // in /workspace
const FETCH_TIMEOUT = 15_000; // 15 seconds
const DOWNLOAD_TIMEOUT = 120; // seconds, the most sandboxExec allows

// a file that's attached to the model: its line ends with its size. a saved or unopenable one's line says so after it instead
const FILE_LINE_RE = /^\((https?:\/\/\S+?)\) \[file: (.+), (\d+(?:\.\d+)? (?:B|KB|MB))\]$/gm;

type FilePart = { type: 'input_text', text: string } | { type: 'input_file', filename: string, fileData: string };
// what a file turned out to be, once downloaded
type LoadedFile = { kind: 'pdf', data: Buffer } | { kind: 'text', text: string, words: number } | { kind: 'unreadable' } | { kind: 'too_large' };
// a file as it's kept, to attach again without downloading it. which message it's from is added when it's saved
type KeptFile = Omit<ConversationFileTable, 'conversation_id' | 'message_id'>;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// the first MAX_FILE_WORDS words, keeping the text's own spacing and line breaks
function firstWords(text: string): string {
  let count = 0;
  for (const match of text.matchAll(/\S+/g)) {
    count += 1;
    if (count === MAX_FILE_WORDS) return text.substring(0, match.index + match[0].length);
  }
  return text;
}

// a name that's safe as a single path part in the sandbox: no slashes, no leading dots
function safeName(name: string): string {
  return name.replace(/[^\w.\- ]/g, '_').replace(/^\.+/, '').substring(0, 100) || 'file';
}

// the last part of a url's path, for a file that's only known by its url
function nameFromURL(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '') || 'file';
  } catch {
    return 'file';
  }
}

/**
 * Downloads a file and works out what it is: a PDF, readable text, or neither.
 * Stops as soon as it's over MAX_FILE_BYTES, so a huge file is never downloaded in full
 */
async function loadFile(url: string): Promise<LoadedFile> {
  const response = await fetch(url, { headers: { 'User-Agent': 'FooBar Discord bot' }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!response.ok) throw new Error(`File fetch responded with status ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) {
    await response.body?.cancel();
    return { kind: 'too_large' };
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body ?? []) { // returning mid-loop cancels the rest of the download
    length += chunk.length;
    if (length > MAX_FILE_BYTES) return { kind: 'too_large' };
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);

  // only by what it starts with, since the name or content type can be wrong (e.g. an error page at a .pdf url), and a broken PDF fails the whole request
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', data };

  // text whatever its content type says, since code and data files often come as application/octet-stream
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (text.includes('\u0000')) return { kind: 'unreadable' };
    return { kind: 'text', text, words: countWords(text) };
  } catch {
    return { kind: 'unreadable' };
  }
}

/**
 * Downloads a file into the sandbox's downloads folder, from inside the container, so it never passes through here.
 * A name that's taken gets -2, -3, ... rather than replacing what's there. Returns its path, relative to /workspace
 */
async function saveToSandbox(url: string, name: string): Promise<string> {
  // the url and name go in as variables, so they're never read as part of the command
  const result = await sandboxExec(`mkdir -p ${DOWNLOAD_DIR} || exit 1
if [[ "$NAME" == *.* ]]; then stem="\${NAME%.*}"; ext=".\${NAME##*.}"; else stem="$NAME"; ext=""; fi
path="${DOWNLOAD_DIR}/$NAME"; n=2
while [ -e "$path" ]; do path="${DOWNLOAD_DIR}/$stem-$n$ext"; n=$((n+1)); done
curl -sSfL --max-filesize ${MAX_DOWNLOAD_BYTES} -o "$path" "$FILE_URL" || { rm -f "$path"; exit 1; }
printf '%s' "$path"`, { env: { NAME: safeName(name), FILE_URL: url }, timeout: DOWNLOAD_TIMEOUT });

  if (result.exit_code !== 0 || !result.stdout) {
    throw new Error(result.timed_out ? 'the download timed out' : (result.stderr.trim() || `the download failed (exit code ${result.exit_code})`));
  }
  return result.stdout;
}

// a readable file as it's kept: the PDF itself, or the text, cut short if it's too long
function keepFile(loaded: LoadedFile, url: string, name: string): KeptFile | undefined {
  if (loaded.kind === 'pdf') return { url, name, kind: 'pdf', content: loaded.data };
  if (loaded.kind !== 'text') return undefined;
  return { url, name, kind: 'text', content: loaded.words > MAX_FILE_WORDS ? firstWords(loaded.text) : loaded.text, words: loaded.words };
}

/**
 * A line for each file in a message that isn't an image, to save in its content, and the readable ones, to keep and attach later.
 * Anything else is saved to the sandbox when canSave, so this only ever runs once per message.
 * A failure is noted in the line rather than thrown, so it never stops a reply
 */
async function describeFiles(message: Message, canSave: boolean): Promise<{ lines: string[], files: KeptFile[] }> {
  const attachments = [...message.attachments.values()].filter((attachment) => !attachment.contentType?.startsWith('image')).slice(0, MAX_FILES);
  const lines: string[] = [];
  const files: KeptFile[] = [];

  // one at a time, so two files with the same name don't both take the same free name in the sandbox
  for (const file of attachments) {
    const label = `${file.name}, ${formatSize(file.size)}`;
    const save = async (): Promise<string> => {
      if (!canSave) return `(${file.url}) [file: ${label}, can't be opened]`;
      try {
        return `(${file.url}) [file: ${label}, saved to ${await saveToSandbox(file.url, file.name)}]`;
      } catch (error: any) {
        console.error(`Couldn't save ${file.name} to the sandbox:`, error);
        return `(${file.url}) [file: ${label}, couldn't be saved: ${error?.message ?? error}]`;
      }
    };

    // discord says how big it is, so a big one isn't downloaded here at all
    if (file.size > MAX_FILE_BYTES) {
      lines.push(await save());
      continue;
    }

    const loaded = await loadFile(file.url).catch((error) => {
      console.error(`Couldn't download ${file.name}:`, error);
      return undefined;
    });
    // a long text file without a sandbox is still kept, cut short when it is
    const kept = loaded && (loaded.kind === 'pdf' || (loaded.kind === 'text' && (loaded.words <= MAX_FILE_WORDS || !canSave))) ? keepFile(loaded, file.url, file.name) : undefined;
    if (!loaded) lines.push(`(${file.url}) [file: ${label}, couldn't be downloaded]`);
    else if (kept) {
      files.push(kept);
      lines.push(`(${file.url}) [file: ${label}]`);
    } else lines.push(await save());
  }

  return { lines, files };
}

// what the model is given for a file: the text in a <file> tag, saying if it was cut short, or the PDF itself
function filePart(file: KeptFile): FilePart {
  if (file.kind === 'pdf') return { type: 'input_file', filename: file.name, fileData: `data:application/pdf;base64,${(file.content as Buffer).toString('base64')}` };
  const cut = (file.words ?? 0) > MAX_FILE_WORDS;
  const name = file.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return { type: 'input_text', text: `<file name="${name}"${cut ? ` cut_off="first ${MAX_FILE_WORDS} of ${file.words} words"` : ''}>\n${file.content}\n</file>` };
}

/**
 * The kept files for a saved message's "(url) [file: name, size]" lines, to give to the model, and the text to go with them,
 * where each line says it's attached. One that wasn't kept (e.g. sent before files were) says it's no longer available
 */
function withFiles(content: string, files: KeptFile[]): { text: string, parts: FilePart[] } {
  const parts: FilePart[] = [];
  const text = content.replace(FILE_LINE_RE, (line, url, name, size) => {
    const file = files.find((kept) => kept.url === url);
    if (file) parts.push(filePart(file));
    return `(${url}) [file: ${name}, ${size}, ${file ? 'attached below' : 'no longer available'}]`;
  });
  return { text, parts };
}

/**
 * A file at a url, for view_file: the text or PDF to give the model, or where it was saved in the sandbox when it's too big
 * or unreadable. Throws if it can't be downloaded, or can't be given or saved
 */
async function viewFile(url: string, canSave: boolean): Promise<{ part?: FilePart, saved?: string, name: string }> {
  const name = nameFromURL(url);
  const loaded = await loadFile(url);
  const kept = loaded.kind === 'pdf' || (loaded.kind === 'text' && (loaded.words <= MAX_FILE_WORDS || !canSave)) ? keepFile(loaded, url, name) : undefined;
  if (kept) return { part: filePart(kept), name };
  if (!canSave) throw new Error(loaded.kind === 'too_large' ? `it's over ${formatSize(MAX_FILE_BYTES)}` : 'it isn\'t text or a PDF, so it can\'t be read');
  return { saved: await saveToSandbox(url, name), name };
}

export { FilePart, KeptFile, MAX_FILE_WORDS, describeFiles, withFiles, viewFile };
