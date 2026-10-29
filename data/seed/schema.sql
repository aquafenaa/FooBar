CREATE TABLE IF NOT EXISTS User(
  user_id VARCHAR(20) PRIMARY KEY,
  user_name VARCHAR(40) NOT NULL,
  user_display VARCHAR(40)
);

CREATE TABLE IF NOT EXISTS Server(
  server_id VARCHAR(20) PRIMARY KEY,
  dm_user_id VARCHAR(20) -- set for a DM with the bot, treated as a server of its own: whose DM it is, which is also its server_id
);

CREATE TABLE IF NOT EXISTS Channel(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  channel_id VARCHAR(20) PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS Message(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  channel_id VARCHAR(20) NOT NULL REFERENCES Channel(channel_id) ON DELETE CASCADE,
  message_id VARCHAR(20) PRIMARY KEY,

  author_id VARCHAR(20) NOT NULL REFERENCES User(user_id)
);

CREATE TABLE IF NOT EXISTS HeartBoard(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  board_name TEXT NOT NULL,
  
  enabled BOOLEAN,
  deny_author BOOLEAN,
  threshold INTEGER,

  output_channel VARCHAR(20),

  PRIMARY KEY(server_id, board_name)
);
CREATE TABLE IF NOT EXISTS HeartBoardEmoji(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  board_name TEXT NOT NULL, 
  emoji TEXT NOT NULL,

  FOREIGN KEY (server_id, board_name) REFERENCES HeartBoard(server_id, board_name) ON DELETE CASCADE,
  PRIMARY KEY(server_id, board_name, emoji)
);
CREATE TABLE IF NOT EXISTS HeartBoardMessage(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  board_name TEXT NOT NULL,
  message_id VARCHAR(20) NOT NULL,

  total_emojis INTEGER NOT NULL,

  channel_id VARCHAR(20) NOT NULL,
  embed_id VARCHAR(20) NOT NULL,

  FOREIGN KEY (server_id, board_name) REFERENCES HeartBoard(server_id, board_name) ON DELETE CASCADE,
  PRIMARY KEY (server_id, board_name, message_id)
);

CREATE TABLE IF NOT EXISTS VoicePing(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  voiceping_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  
  message_template VARCHAR(2000),
  output_channel VARCHAR(20),

  PRIMARY KEY (server_id, voiceping_name)
);
CREATE TABLE IF NOT EXISTS VoicePingInput(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  channel_id VARCHAR(20) NOT NULL,
  voiceping_name TEXT NOT NULL,

  PRIMARY KEY (server_id, voiceping_name, channel_id),
  FOREIGN KEY (server_id, voiceping_name) REFERENCES VoicePing(server_id, voiceping_name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Chatbot(
  server_id VARCHAR(20) PRIMARY KEY REFERENCES Server(server_id) ON DELETE CASCADE,

  chatbot_enabled BOOLEAN,
  tools_enabled BOOLEAN,
  detached BOOLEAN,
  model TEXT,
  reasoning_effort TEXT,
  temperature REAL,
  system_prompt_override TEXT,
  chatbot_prompt TEXT,
  disabled_tools TEXT
);
CREATE TABLE IF NOT EXISTS ChatbotSubscriber(
  server_id VARCHAR(20) REFERENCES Server(server_id) ON DELETE CASCADE,
  user_id VARCHAR(20),
  cross_server BOOLEAN,

  PRIMARY KEY(server_id, user_id)
);
CREATE TABLE IF NOT EXISTS SavedAnonymizedChats(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  message_id VARCHAR(20),

  reference_content TEXT,
  message_content VARCHAR(2000) NOT NULL,

  PRIMARY KEY (server_id, message_id)
);

CREATE TABLE IF NOT EXISTS Memory(
  source_id VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL COLLATE NOCASE,
  content TEXT NOT NULL,

  PRIMARY KEY (source_id, name)
);

CREATE TABLE IF NOT EXISTS Conversation(
  conversation_id VARCHAR(50) PRIMARY KEY,
  platform VARCHAR(50) NOT NULL,
  channel_id VARCHAR(50),
  source_id VARCHAR(50),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ConversationMessage(
  conversation_id VARCHAR(50) NOT NULL REFERENCES Conversation(conversation_id) ON DELETE CASCADE,
  message_id VARCHAR(50) NOT NULL,
  reference_id VARCHAR(50),

  token_count INTEGER NOT NULL,

  author_name VARCHAR(40) NOT NULL,
  author_id VARCHAR(50) NOT NULL,

  role VARCHAR (9),
  message_content TEXT,
  timestamp INTEGER,

  PRIMARY KEY (conversation_id, message_id)
);
CREATE TABLE IF NOT EXISTS ConversationToolResult(
  conversation_id VARCHAR(50) NOT NULL REFERENCES Conversation(conversation_id) ON DELETE CASCADE,
  tool_name VARCHAR(50) NOT NULL,
  tool_call_id VARCHAR(100) NOT NULL,
  timestamp INTEGER,
  output TEXT,
  dirty BOOLEAN,
  discarded TEXT,

  PRIMARY KEY (conversation_id, tool_call_id)
);
CREATE TABLE IF NOT EXISTS ConversationSummary(
  conversation_id VARCHAR(50) NOT NULL REFERENCES Conversation(conversation_id) ON DELETE CASCADE,
  source_id VARCHAR(100) NOT NULL,
  summary TEXT,
  timestamp INTEGER,
  embedding BLOB,

  PRIMARY KEY (conversation_id, source_id)
);
CREATE TABLE IF NOT EXISTS IndexUser(
  conversation_id VARCHAR(50) NOT NULL REFERENCES Conversation(conversation_id) ON DELETE CASCADE,
  user_id VARCHAR(20) NOT NULL,
  shorthand VARCHAR(20) NOT NULL,

  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS IndexMessage(
  conversation_id VARCHAR(50) NOT NULL REFERENCES Conversation(conversation_id) ON DELETE CASCADE,
  message_id VARCHAR(20) NOT NULL,
  shorthand VARCHAR(20) NOT NULL,

  PRIMARY KEY (conversation_id, message_id)
);
CREATE TABLE IF NOT EXISTS IndexChannel(
  conversation_id VARCHAR(50) NOT NULL REFERENCES Conversation(conversation_id) ON DELETE CASCADE,
  channel_id VARCHAR(20) NOT NULL,
  shorthand VARCHAR(20) NOT NULL,

  PRIMARY KEY (conversation_id, channel_id)
);
CREATE TABLE IF NOT EXISTS IndexRole(
  conversation_id VARCHAR(50) NOT NULL REFERENCES Conversation(conversation_id) ON DELETE CASCADE,
  role_id VARCHAR(20) NOT NULL,
  shorthand VARCHAR(20) NOT NULL,

  PRIMARY KEY (conversation_id, role_id)
);

CREATE TABLE IF NOT EXISTS AutomaticResponse(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  name VARCHAR(40) NOT NULL,
  
  enabled BOOLEAN NOT NULL,
  activation_regex VARCHAR(40) NOT NULL,
  capture_regex VARCHAR(40),
  output_template VARCHAR(40) NOT NULL,

  PRIMARY KEY (server_id, name)
);
CREATE TABLE IF NOT EXISTS ResponseMessage(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  message_id VARCHAR(20) NOT NULL,

  PRIMARY KEY (server_id, message_id)
);

CREATE TABLE IF NOT EXISTS Reminder(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  channel_id VARCHAR(20) NOT NULL,
  reminder_name VARCHAR(40) NOT NULL,

  repeats BOOLEAN,
  cron_schedule VARCHAR(40) NOT NULL,
  message_content TEXT,

  PRIMARY KEY (server_id, reminder_name)
);

CREATE TABLE IF NOT EXISTS Heartbeat(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  heartbeat_name VARCHAR(40) NOT NULL COLLATE NOCASE,
  channel_id VARCHAR(20) NOT NULL,
  created_by VARCHAR(20) NOT NULL,

  repeats BOOLEAN,
  silent BOOLEAN,
  cron_schedule VARCHAR(40) NOT NULL,
  prompt TEXT NOT NULL,
  context TEXT,

  PRIMARY KEY (server_id, heartbeat_name)
);

CREATE TABLE IF NOT EXISTS Counter(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  counter_name VARCHAR(40) NOT NULL COLLATE NOCASE,
  value INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (server_id, counter_name)
);
