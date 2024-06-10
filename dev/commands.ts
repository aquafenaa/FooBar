import { Player, useQueue } from 'discord-player';
import { SoundCloudExtractor, SpotifyExtractor, YouTubeExtractor } from '@discord-player/extractor';
import {
  Channel,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  CommandInteraction, EmbedBuilder, GuildMember, SlashCommandBuilder, TextChannel,
} from 'discord.js';
import { Command, ConfigData, Server } from './types';

let player: Player;

function startPlayer(client: Client<boolean>) {
  player = new Player(client);
  player.extractors.loadDefault();

  player.extractors.register(SpotifyExtractor, {});
  player.extractors.register(SoundCloudExtractor, {});
  // player.extractors.register(YouTubeExtractor, {});

  player.events.on('playerStart', (queue, track) => {
    const requester = track.requestedBy!;

    const embed = new EmbedBuilder().setTitle('Now Playing')
      .setAuthor({ name: requester.username, iconURL: requester.displayAvatarURL() })
      .addFields({ name: track.title, value: `${track.author} (${track.duration})` });
    // @ts-ignore
    queue.metadata.send({ embeds: [embed] });
  });
}

const Help: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Displays all commands!'),
  async execute(interaction: CommandInteraction): Promise<void> {
    await interaction.reply('Pong!');
  },
};

function buildVoicePingEmbed(server: Server) {
  const { enabled, voicePingMessage, inputChannels, outputChannel } = server.voicePing;

  return new EmbedBuilder()
    .setTitle('Voice Ping Settings')
    .setDescription('Voice ping settings for this server')
    .addFields(
      { name: 'Enabled', value: (enabled ? 'Yes' : 'No') },
      { name: 'Message', value: voicePingMessage ?? 'No message set' },
      { name: 'Listener Channels', value: inputChannels && inputChannels.length > 0 ? inputChannels?.map((id) => `<#${id}>`)?.join(', ') : 'No channels set' },
      { name: 'Log Channel', value: outputChannel ? `<#${outputChannel}>` : 'No channel set' },
    );
}

const VoicePing: Command = {
  data: new SlashCommandBuilder()
    .setName('voiceping')
    .setDescription('Sends a message when a user joins a voice channel')
    .addSubcommand((subcommand) => subcommand.setName('test')
      .setDescription('Test the voice ping message to the output channel'))
    .addSubcommandGroup((group) => group.setName('settings')
      .setDescription('View and edit the voice ping settings')
      .addSubcommand((subcommand) => subcommand.setName('view')
        .setDescription('View the current voice ping settings'))
      .addSubcommand((subcommand) => subcommand.setName('edit')
        .setDescription('Edit the current voice ping settings')
        .addBooleanOption((option) => option.setName('enabled')
          .setDescription('Enter "True" to enable, or "False" to disable.'))
        .addStringOption((option) => option.setName('message')
          .setDescription('Message to send when a user joins. {user} mentions the user, and {channel} mentions the channel.'))
        .addStringOption((option) => option.setName('inputs')
          .setDescription('The channels to listen for voice users joining. Enter channel IDs seperated by a space.'))
        .addChannelOption((option) => option.setName('output')
          .setDescription('Desired channel to output the message to')))),

  async execute(interaction: ChatInputCommandInteraction, config: ConfigData): Promise<ConfigData | void> {
    const server = config?.servers?.find((s) => s.id === interaction.guild?.id);

    if (config === undefined) { console.error('Config is undefined'); return; }
    if (server === undefined) { console.error('Server is undefined'); return; }

    let { enabled, voicePingMessage, inputChannels, outputChannel } = server.voicePing;

    let tempMessage = '';

    if (interaction.options.getSubcommand() === 'test') {
      if (outputChannel === undefined || outputChannel === '') {
        tempMessage += 'No output channel set! Testing in this channel.\n';
        outputChannel = interaction.channel?.id ?? '';
      }
      if (voicePingMessage?.includes('{channel}') && (inputChannels === undefined || inputChannels.length === 0)) {
        tempMessage += 'No input channels set! Testing using a random voice channel.';
        inputChannels = [interaction.guild?.channels.cache?.find((c: Channel) => c.type === ChannelType.GuildVoice)?.id ?? interaction.channel?.id ?? ''];
      }

      const channel: TextChannel = interaction.guild?.channels.cache.get(outputChannel) as TextChannel;

      if (channel === undefined) {
        await interaction.reply({ content: 'Invalid output channel!', ephemeral: true });

        return;
      }

      if (tempMessage === '') {
        tempMessage += 'Testing voice ping message!';
      }

      await interaction.reply({ content: tempMessage, ephemeral: true });

      await channel.send(voicePingMessage?.replace('{user}', interaction.user.toString()).replace('{channel}', `<#${inputChannels[0]}>`));

      return;
    }

    if (interaction.options.getSubcommandGroup() === 'settings') {
      if (interaction.options.getSubcommand() === 'view') {
        await interaction.reply({ embeds: [buildVoicePingEmbed(server)], ephemeral: true });

        return;
      }

      if (interaction.options.getSubcommand() === 'edit') {
        const enable = interaction.options.getBoolean('enabled');
        const message = interaction.options.getString('message');
        const inputs = interaction.options.getString('inputs')?.split(' ');
        const output = interaction.options.getChannel('output')?.id;

        if (enable !== null) {
          enabled = enable;
        }
        if (message !== null) {
          voicePingMessage = message;
        }
        if (inputs !== undefined) {
          inputChannels = inputs;
        }
        if (output !== undefined) {
          outputChannel = output;
        }

        server.voicePing = {
          enabled,
          voicePingMessage,
          inputChannels,
          outputChannel,
        };

        await interaction.reply({ embeds: [buildVoicePingEmbed(server)], ephemeral: true });

        const index = config.servers?.findIndex((s) => s.id === interaction.guild?.id);
        const newConfig = config;
        newConfig.servers[index] = server;

        // eslint-disable-next-line consistent-return
        return newConfig;
      }
    }
  },
};

const Music: Command = {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('Plays a song inside of a voice channel!')
    .addSubcommand((subcommand) => {
      subcommand.setName('play').setDescription('Plays a song inside of a voice channel!')
        .addStringOption((option) => {
          option.setName('query').setDescription('What you would like to search for')
            .setRequired(true);

          return option;
        });

      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand.setName('skip').setDescription('Skips current song in the queue')
        .addIntegerOption((option) => {
          option.setName('tracks').setDescription('Number of tracks to be skipped');

          return option;
        });

      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand.setName('remove').setDescription('Removes song(s) from the queue')
        .addIntegerOption((option) => {
          option.setName('index').setDescription('The position in queue of said song. See \'music queue\' for the queue')
            .setRequired(true);

          return option;
        });

      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand.setName('shuffle').setDescription('Shuffles songs in the queue');

      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand.setName('pause').setDescription('Pauses the current queue');

      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand.setName('view').setDescription('Views the current queue');

      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand.setName('volume').setDescription('Change or view the volume of the music')
        .addNumberOption((option) => {
          option.setName('volume').setDescription('The volume to change it to');

          return option;
        });

      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand.setName('loop').setDescription('Checks or changes the loop mode: the current song, the current track, or adds autoplay')
        .addIntegerOption((option) => {
          option.setName('mode').setDescription('The mode of looping to change to');
          option.addChoices(
            { name: 'Looping Off', value: 0 },
            { name: 'Loop Current Track', value: 1 },
            { name: 'Loop Current Queue', value: 2 },
            { name: 'Autoplay', value: 3 },
          );

          return option;
        });

      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand.setName('stop').setDescription('Stops the current queue');

      return subcommand;
    }),
  async execute(interaction: ChatInputCommandInteraction, configData: ConfigData): Promise<ConfigData | void> {
    const server = configData.servers.find((s) => s.id === interaction.guild!.id);

    if (!server) {
      interaction.reply({ content: 'Please use this command in a server!', ephemeral: true });

      return;
    }

    if (server.musicChannel && interaction.channel!.id !== server.musicChannel) {
      interaction.reply({ content: `Please use this command in the <#${server.musicChannel}> channel!`, ephemeral: true });

      return;
    }
    if (interaction.options.getSubcommand() === 'play') {
      const query = interaction.options.getString('query')!;
      // const location: Location = interaction.options.getString('location') as Location;

      const queue = useQueue(interaction.guild!.id);
      if (queue && queue.node.isPaused()) {
        queue.node.setPaused(false);

        return;
      }

      if (!(interaction.member instanceof GuildMember)) {
        interaction.reply({ content: 'Error!', ephemeral: true });
        return;
      }

      const channel = interaction.member?.voice?.channel ?? undefined;
      if (!channel) {
        interaction.reply({ content: 'You are not connected to a voice channel!', ephemeral: true });
        return;
      }

      await interaction.deferReply();

      try {
        const { track } = await player.play(channel, query, {
          ytdlOptions: {
            quality: 'highestaudio',
            highWaterMark: 1 << 25,
          },
          requestedBy: interaction.user,
          nodeOptions: {
            metadata: interaction.channel,
          },
        });

        interaction.followUp(`**${track.title}** by *${track.author}* (${track.duration}) enqueued!`);
      } catch (e) {
        interaction.followUp({ content: `Something went wrong: ${e}`, ephemeral: true });
      }
    } else if (interaction.options.getSubcommand() === 'skip') {
      const tracks = interaction.options.getInteger('tracks') ?? 1;
      const queue = useQueue(interaction.guild!.id);

      if (!queue || !queue.currentTrack) {
        interaction.reply({ content: 'There is no queue playing!', ephemeral: true });

        return;
      }

      if (tracks > queue.tracks.toArray().length) {
        interaction.reply({ content: '🚫 | Successfully stopped queue!', ephemeral: true });
        queue.delete();

        return;
      }

      const currentSong = queue.currentTrack;
      // eslint-disable-next-line no-plusplus
      for (let i = 0; i < tracks - 1; i++) {
        queue.removeTrack(0);
      }

      queue.node.skip();
      if (tracks > 1) {
        interaction.reply(`⏩ | Successfully skipped ${tracks} songs!`);

        return;
      }

      interaction.reply(`⏩ | Successfully skipped **${currentSong.title}** by *${currentSong.author}!*`);
    } else if (interaction.options.getSubcommand() === 'remove') {
      const queue = useQueue(interaction.guild!.id ?? 'undefined');
      const index = interaction.options.getInteger('index')!;

      if (!queue) {
        interaction.reply({ content: 'There is no queue playing!', ephemeral: true });

        return;
      }

      queue.removeTrack(index);
    } else if (interaction.options.getSubcommand() === 'shuffle') {
      const queue = useQueue(interaction.guild!.id ?? 'undefined');

      if (!queue) {
        interaction.reply({ content: 'There is no queue playing!', ephemeral: true });

        return;
      }

      queue.tracks.shuffle();
    } else if (interaction.options.getSubcommand() === 'pause') {
      const queue = useQueue(interaction.guild!.id ?? 'undefined');

      if (!queue) {
        interaction.reply({ content: 'There is no queue playing!', ephemeral: true });

        return;
      }

      queue.node.setPaused(!queue.node.isPaused());
    } else if (interaction.options.getSubcommand() === 'view') {
      const queue = useQueue(interaction.guild!.id ?? 'undefined');

      if (!queue) {
        interaction.reply({ content: 'There is no queue playing!', ephemeral: true });

        return;
      }

      const trackArray = queue.tracks.toArray();
      const { currentTrack } = queue;

      const trackMap = trackArray.map((track) => ({ name: track.title, value: `${track.author} (${track.duration}) | ${track.toHyperlink()}` }));
      const currentTrackMap = { name: currentTrack!.title, value: `${currentTrack!.author} | ${currentTrack!.toHyperlink()}\n${queue.node.createProgressBar()}` };
      trackMap.unshift(currentTrackMap);

      const embed = new EmbedBuilder().setTitle('Current Queue').addFields(trackMap);

      interaction.reply({ embeds: [embed] });
    } else if (interaction.options.getSubcommand() === 'stop') {
      const queue = useQueue(interaction.guild!.id);

      if (!queue) {
        interaction.reply({ content: 'There is no queue playing!', ephemeral: true });

        return;
      }

      queue.delete();

      interaction.reply('🚫 | Successfully stopped queue!');
    } else if (interaction.options.getSubcommand() === 'volume') {
      const volume = interaction.options.getNumber('volume');
      const queue = useQueue(interaction.guild!.id ?? 'undefined');

      if (!queue) {
        interaction.reply({ content: 'There is no queue playing!', ephemeral: true });

        return;
      }

      if (!volume) {
        const currentVolume = queue.node.volume;

        interaction.reply({ content: `The current volume is ${currentVolume}%`, ephemeral: true });

        return;
      }

      queue.node.setVolume(volume);

      interaction.reply({ content: `🔊 | Volume successfully changed to ${volume}%`, ephemeral: true });
    } else if (interaction.options.getSubcommand() === 'loop') {
      const repeatMode = interaction.options.getInteger('mode');
      const queue = useQueue(interaction.guild!.id ?? 'undefined');

      if (!queue) {
        interaction.reply({ content: 'There is no queue playing!', ephemeral: true });

        return;
      }

      if (!repeatMode) {
        const currentMode = queue.repeatMode;

        // eslint-disable-next-line no-nested-ternary
        const modeString = (currentMode === 0) ? 'Off' : (currentMode === 1) ? 'Current Track' : (currentMode === 2) ? 'Entire Queue' : (currentMode === 3) ? 'Autoplay' : 'Unknown!';

        interaction.reply({ content: `The current mode is set to ${modeString}`, ephemeral: true });

        return;
      }

      // eslint-disable-next-line no-nested-ternary
      const modeString = (repeatMode === 0) ? 'Off' : (repeatMode === 1) ? 'Current Track' : (repeatMode === 2) ? 'Entire Queue' : (repeatMode === 3) ? 'Autoplay' : 'Unknown!';

      queue.setRepeatMode(repeatMode);
      interaction.reply(`Successfully set repeat mode to ${modeString}`);
    }
  },
};

const commandMap: Map<string, Command> = new Map();
commandMap.set(Help.data.name, Help);
commandMap.set(VoicePing.data.name, VoicePing);
commandMap.set(Music.data.name, Music);

export { startPlayer, commandMap, Help, VoicePing, Music };
