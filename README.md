# FooBar
This is the source code for a discord bot. It contains features that I think are useful, as well as features I find funny for my personal server. 
If you would like to add this bot to your own server, feel free! If you encounter any issues or have suggestions, please create a report [here](https://github.com/aquafenaa/FooBar/issues)
----
### Features
- [x] Voice Ping 
  - Sends a message in a given text channel if a user joins a specified voice channel
  - [ ] Message / Role tied to each channel

- [x] Heartboard
  - When a message receives enough reactions, it is captured as an embed and sent to a specified channel
- [ ] Hateboard
  - Like heartboard but negative, and with separate reactions
  - Perhaps just allow multiple heartboards, but that's harder

- [ ] Show ratings
  - Calculates average score of a show via user's reactions / interations
- [ ] Position Tracker
 - Command to keep track of position in shows
 - Includes season, episode, and possible time

- [x] Grok AI?? <small>*highly experimental, recommended to keep disabled*</small>
  - Stupid LLM that responds when pinged or replied to
  - [ ] Command to reset AI memory

- [ ] Woke Meter
  - [ ] You can upvote or downvote a message there's the woker of the month
  - [ ] Social Woke Score (words are woke or broke)

- [ ] Music Bot
  - Plays songs in vc when given a title

- [ ] Date & Time Command
  - [ ] Choose local timezone. Whenever you mention a time in a message, it sends a localized response for everyone else. React with 🗑️ to delete the response
  - [ ] Localized command to get pregenerated localized time tags
  - [ ] Birthdate reminders
---
#### **TODO**
- [ ] Fix help command
- [x] Solidify config as its own command
- [ ] Permission-only access to admin commands
- [ ] Test subcommand of config
- [ ] Replied-to heartboard message added as preliminary embed
- [ ] Command to reset config & data