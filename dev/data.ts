import path from 'node:path';
import { Snowflake } from 'discord.js';
import { readFile, writeFile } from 'fs/promises';

import { ConfigData, SaveData, ServerData, ServerConfig, defaultHeartboardConfig, defaultVoicepingConfig } from './types';

const dataPath = path.join(__dirname, '../data/data.json');
const configPath = path.join(__dirname, '../data/config.json');

let configBeingUsed = false;
let dataBeingUsed = false;

// WRITES GIVEN DATA TO RELATIVE LOCATION
async function writeData(saveData: SaveData) {
  if (dataBeingUsed) {
    return new Promise((resolve) => {
      setTimeout(async () => {
        resolve(await writeData(saveData));
      }, 200);
    });
  }

  dataBeingUsed = true;

  const saveDataString = JSON.stringify(saveData, null, 2);
  await writeFile(dataPath, saveDataString);

  dataBeingUsed = false;
}

async function writeConfig(saveData: ConfigData) {
  if (configBeingUsed) {
    return new Promise((resolve) => {
      setTimeout(async () => {
        resolve(await writeConfig(saveData));
      }, 200);
    });
  }

  configBeingUsed = true;

  const saveDataString = JSON.stringify(saveData, null, 2);
  await writeFile(configPath, saveDataString);

  configBeingUsed = false;
}

// READS DATA FROM RELATIVE LOCATION
async function readData(): Promise<SaveData> {
  if (dataBeingUsed) {
    return new Promise((resolve) => {
      setTimeout(async () => {
        resolve(await readData());
      }, 200);
    });
  }

  dataBeingUsed = true;

  const result = JSON.parse(await readFile(dataPath, 'utf-8'));

  dataBeingUsed = false;
  return result;
}

async function readConfig(): Promise<ConfigData> {
  if (configBeingUsed) {
    return new Promise((resolve) => {
      setTimeout(async () => {
        resolve(await readConfig());
      }, 200);
    });
  }

  return JSON.parse(await readFile(configPath, 'utf-8'));
}

// ADDS A NEW SERVER IF GUILD ID DOESN'T EXIST
async function addData(guildID: string): Promise<ServerData> {
  const data = await readData();

  const oldData = data.servers.find((s) => s.id === guildID);
  if (oldData) return oldData;

  const serverData: ServerData = {
    id: guildID,
    heartBoardMessages: [],

    chatbotCoreMemory: '',
    chatbotLongtermMemory: [],
    chatbotShortTermMessages: [],
  };

  data.servers.push(serverData);
  writeData(data);

  return serverData;
}

async function addConfig(guildID: string): Promise<ServerConfig> {
  const config = await readConfig();

  const oldConfig = config.servers.find((s) => s.id === guildID);
  if (oldConfig) return oldConfig;

  const serverConfig: ServerConfig = {
    id: guildID,

    aiEnabled: false,
    serverResponses: [],
    heartBoard: defaultHeartboardConfig,
    voicePing: defaultVoicepingConfig,
  };

  config.servers.push(serverConfig);
  writeConfig(config);

  return serverConfig;
}

// GETS DATA GIVEN A GUILD ID
async function getServerData(guildID: Snowflake): Promise<ServerData | undefined> {
  const data = await readData();

  const serverData = data.servers.find((s) => s.id === guildID);

  return serverData ?? await addData(guildID);
}

async function getServerConfig(guildID: Snowflake): Promise<ServerConfig | undefined> {
  const config = await readConfig();

  return config.servers.find((server) => server.id === guildID);
}

// EDITS AN EXISTING SERVER IF IT EXISTS, OR CREATES ONE
async function editServerData(serverData: ServerData) {
  const data = await readData();
  const index = data.servers.findIndex((server) => server.id === serverData.id);

  if (index === -1) {
    data.servers.push(serverData);
  } else {
    data.servers[index] = serverData;
  }

  writeData(data);
}

async function editServerConfig(serverConfig: ServerConfig) {
  const config = await readConfig();
  const index = config.servers.findIndex((server) => server.id === serverConfig.id);

  if (index === -1) {
    config.servers.push(serverConfig);
  } else {
    config.servers[index] = serverConfig;
  }

  writeConfig(config);
}

// REPAIRS AN INCOMPLETE SERVER DATA WITH DEFAULT DATA
function repairServerData(serverData: any): ServerData {
  if (!serverData.id) return serverData;

  const fixedData: ServerData = {
    id: serverData.id,

    heartBoardMessages: serverData.heartboardMessage ?? [],
    chatbotCoreMemory: serverData.chatbotCoreMemory ?? '',
    chatbotLongtermMemory: serverData.chatbotLongtermMemory ?? [],
    chatbotShortTermMessages: serverData.chatbotShortTermMessages ?? [],
  };

  editServerData(fixedData); // update if changed
  return fixedData;
}

function repairServerConfig(serverConfig: any): ServerConfig {
  const fixedConfig: ServerConfig = {
    id: serverConfig.id,

    aiEnabled: serverConfig.aiEnabled ?? false,
    serverResponses: serverConfig.serverResponses ?? [],
    heartBoard: serverConfig.heartBoard ?? defaultHeartboardConfig,
    voicePing: serverConfig.voicePing ?? defaultVoicepingConfig,
  };

  editServerConfig(fixedConfig); // update if changed
  return fixedConfig;
}

export {
  writeData, readData, writeConfig, readConfig, getServerConfig, getServerData, addData, addConfig,
  editServerData, editServerConfig, repairServerData, repairServerConfig,
};
