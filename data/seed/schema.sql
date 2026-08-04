CREATE TABLE IF NOT EXISTS User(
  user_id VARCHAR(20) PRIMARY KEY,
  user_name VARCHAR(40) NOT NULL,
  user_display VARCHAR(40)
);

CREATE TABLE IF NOT EXISTS Server(
  server_id VARCHAR(20) PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS Chatbot(
  server_id VARCHAR(20) PRIMARY KEY REFERENCES Server(server_id) ON DELETE CASCADE,

  chatbot_enabled BOOLEAN,
  chatbot_core_memory TEXT
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

CREATE TABLE IF NOT EXISTS ChatbotLongTermMemory(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  memory_id INTEGER NOT NULL,
  message_content VARCHAR(2000),

  timestamp INTEGER,
  PRIMARY KEY (server_id, memory_id)
);
CREATE TABLE IF NOT EXISTS ChatbotShortTermMemory(
  server_id VARCHAR(20) NOT NULL REFERENCES Server(server_id) ON DELETE CASCADE,
  message_id VARCHAR(20) NOT NULL,

  author_name VARCHAR(40) NOT NULL,
  
  author_id VARCHAR(20) NOT NULL REFERENCES User(user_id),
  role VARCHAR (9),
  message_content VARCHAR(2000),
  timestamp INTEGER,
  
  PRIMARY KEY (server_id, message_id)
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
