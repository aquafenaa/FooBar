import { readFile, writeFile } from 'fs/promises';
import path from 'node:path';
import { ConfigData } from './types';

const configPath = path.join(__dirname, '../data/config.json');
let configBeingUsed = false;

async function writeConfig(saveData: ConfigData) {
  configBeingUsed = true;

  const saveDataString = JSON.stringify(saveData, null, 2);
  await writeFile(configPath, saveDataString);

  configBeingUsed = false;
}

async function readConfig(): Promise<ConfigData> {
  if (configBeingUsed) {
    return new Promise((resolve) => {
      setTimeout(async () => {
        resolve(await readConfig());
      }, 100);
    });
  }

  return JSON.parse(await readFile(configPath, 'utf-8'));
}

export { writeConfig, readConfig };
