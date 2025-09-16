// index.js
// Install: npm install discord.js
// Run: node index.js
const { 
    Client, GatewayIntentBits, Partials, 
    PermissionsBitField, REST, Routes, SlashCommandBuilder, EmbedBuilder 
  } = require("discord.js");
  
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildModeration
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
  });
  
  // ==== SECURE CONFIG ====
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
  const WARN_CHANNEL_ID = process.env.WARN_CHANNEL_ID;
  const BAN_CHANNEL_ID = process.env.BAN_CHANNEL_ID;
  const OWNER_ID = process.env.OWNER_ID;
  const HEAD_STAFF_IDS = process.env.HEAD_STAFF_IDS ? process.env.HEAD_STAFF_IDS.split(',') : [];
  const STAFF_WHITELIST = process.env.STAFF_WHITELIST ? process.env.STAFF_WHITELIST.split(',') : [];
  
  // Validation
  if (!BOT_TOKEN) {
    console.error("❌ BOT_TOKEN is required!");
    process.exit(1);
  }
  
  // In-memory data
  let warnings = new Map();
  let actionsLog = [];
  let channelBackups = new Map();
  let staffRoles = new Map(); // guildId -> [roleIds]
  
  // ==== SLASH COMMANDS ====
  const commands = [
    // Staff management commands (Owner only)
    new SlashCommandBuilder()
      .setName("addstaff")
      .setDescription("Add a staff role (Owner only)")
      .addRoleOption(opt => opt.setName("role").setDescription("Role to add as staff").setRequired(true))
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  
    new SlashCommandBuilder()
      .setName("removestaff")
      .setDescription("Remove a staff role (Owner only)")
      .addRoleOption(opt => opt.setName("role").setDescription("Role to remove from staff").setRequired(true))
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  
    new SlashCommandBuilder()
      .setName("liststaff")
      .setDescription("List all staff roles (Owner only)")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  
    // Moderation commands (Staff only)
    new SlashCommandBuilder()
      .setName("ban")
      .setDescription("Ban a member")
      .addUserOption(opt => opt.setName("target").setDescription("Member to ban").setRequired(true))
      .addStringOption(opt => opt.setName("reason").setDescription("Reason"))
      .setDefaultMemberPermissions(0), // Hide from everyone by default
  
    new SlashCommandBuilder()
      .setName("kick")
      .setDescription("Kick a member")
      .addUserOption(opt => opt.setName("target").setDescription("Member to kick").setRequired(true))
      .addStringOption(opt => opt.setName("reason").setDescription("Reason"))
      .setDefaultMemberPermissions(0),
    
    new SlashCommandBuilder()
      .setName("mute")
      .setDescription("Mute a member (timeout)")
      .addUserOption(opt => opt.setName("target").setDescription("Member to mute").setRequired(true))
      .addIntegerOption(opt => opt.setName("minutes").setDescription("Duration in minutes").setRequired(true))
      .setDefaultMemberPermissions(0),
    
    new SlashCommandBuilder()
      .setName("unban")
      .setDescription("Unban a user")
      .addStringOption(opt => opt.setName("userid").setDescription("User ID to unban").setRequired(true))
      .setDefaultMemberPermissions(0),
    
    new SlashCommandBuilder()
      .setName("warn")
      .setDescription("Warn a member")
      .addUserOption(opt => opt.setName("target").setDescription("Member to warn").setRequired(true))
      .addStringOption(opt => opt.setName("reason").setDescription("Reason"))
      .setDefaultMemberPermissions(0),
    
    new SlashCommandBuilder()
      .setName("restore")
      .setDescription("Undo all actions performed by a staff user")
      .addUserOption(opt => opt.setName("staff").setDescription("Staff member to rollback").setRequired(true))
      .setDefaultMemberPermissions(0),
  ]
  .map(cmd => cmd.toJSON());
  
  // ==== STAFF SYSTEM HELPERS ====
  function isOwner(userId) {
    return userId === OWNER_ID;
  }
  
  function isHeadStaff(userId) {
    return isOwner(userId) || HEAD_STAFF_IDS.includes(userId);
  }
  
  function isStaff(member) {
    // Check whitelist first (primary method)
    if (STAFF_WHITELIST.includes(member.user.id)) return true;
    
    // Also check role-based staff (secondary method)
    const guildStaffRoles = staffRoles.get(member.guild.id) || [];
    return member.roles.cache.some(role => guildStaffRoles.includes(role.id));
  }
  
  function isWhitelisted(userId) {
    return STAFF_WHITELIST.includes(userId);
  }
  
  function addStaffRole(guildId, roleId) {
    const currentRoles = staffRoles.get(guildId) || [];
    if (!currentRoles.includes(roleId)) {
      currentRoles.push(roleId);
      staffRoles.set(guildId, currentRoles);
      return true;
    }
    return false;
  }
  
  function removeStaffRole(guildId, roleId) {
    const currentRoles = staffRoles.get(guildId) || [];
    const index = currentRoles.indexOf(roleId);
    if (index > -1) {
      currentRoles.splice(index, 1);
      staffRoles.set(guildId, currentRoles);
      return true;
    }
    return false;
  }
  
  // ==== REGISTER COMMANDS ====
  client.once("ready", async () => {
    console.log(`${client.user.tag} is online!`);
    
    // Save channel backups
    client.guilds.cache.forEach(guild => {
      guild.channels.cache.forEach(channel => saveChannelBackup(channel));
    });
  
    const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
    try {
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands }
      );
      console.log("✅ Slash commands registered.");
      console.log(`📋 Whitelisted staff: ${STAFF_WHITELIST.length} users`);
    } catch (err) {
      console.error(err);
    }
  });
  
  // ==== MEMBER EVENTS (Security Logs) ====
  client.on("guildMemberAdd", async (member) => {
    const embed = new EmbedBuilder()
      .setColor("Green")
      .setTitle("📥 Member Joined")
      .setDescription(`${member.user} joined the server.`)
      .addFields(
        { name: "User", value: `${member.user.tag} (${member.user.id})` },
        { name: "Account Created", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>` },
        { name: "Member Count", value: `${member.guild.memberCount}` }
      )
      .setThumbnail(member.user.displayAvatarURL())
      .setTimestamp();
  
    logSecurityAction(null, embed);
  });
  
  client.on("guildMemberRemove", async (member) => {
    const embed = new EmbedBuilder()
      .setColor("Red")
      .setTitle("📤 Member Left")
      .setDescription(`${member.user} left the server.`)
      .addFields(
        { name: "User", value: `${member.user.tag} (${member.user.id})` },
        { name: "Joined Server", value: member.joinedAt ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : "Unknown" },
        { name: "Roles", value: member.roles.cache.size > 1 ? member.roles.cache.filter(r => r.name !== "@everyone").map(r => r.name).join(", ") : "None" },
        { name: "Member Count", value: `${member.guild.memberCount}` }
      )
      .setThumbnail(member.user.displayAvatarURL())
      .setTimestamp();
  
    logSecurityAction(null, embed);
  });
  
  // Member role updates (Security logs)
  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;
    
    const addedRoles = newRoles.filter(role => !oldRoles.has(role.id));
    const removedRoles = oldRoles.filter(role => !newRoles.has(role.id));
    
    if (addedRoles.size > 0 || removedRoles.size > 0) {
      const embed = new EmbedBuilder()
        .setColor("Yellow")
        .setTitle("🏷️ Role Update")
        .setDescription(`${newMember.user}'s roles were updated.`)
        .addFields({ name: "User", value: `${newMember.user.tag} (${newMember.user.id})` });
  
      if (addedRoles.size > 0) {
        embed.addFields({ name: "➕ Roles Added", value: addedRoles.map(r => r.name).join(", ") });
      }
      
      if (removedRoles.size > 0) {
        embed.addFields({ name: "➖ Roles Removed", value: removedRoles.map(r => r.name).join(", ") });
      }
  
      embed.setThumbnail(newMember.user.displayAvatarURL()).setTimestamp();
      logSecurityAction(null, embed);
    }
  });
  
  // ==== BACKUP SYSTEM ====
  function saveChannelBackup(channel) {
    channelBackups.set(channel.id, {
      name: channel.name,
      type: channel.type,
      parent: channel.parentId,
      position: channel.rawPosition,
      permissionOverwrites: channel.permissionOverwrites.cache.map(po => ({
        id: po.id,
        allow: po.allow.bitfield.toString(),
        deny: po.deny.bitfield.toString(),
        type: po.type
      }))
    });
  }
  
  client.on("channelDelete", channel => {
    saveChannelBackup(channel);
  });
  
  async function restoreChannels(guild) {
    for (const [id, data] of channelBackups) {
      const exists = guild.channels.cache.get(id);
      if (!exists) {
        const newChannel = await guild.channels.create({
          name: data.name,
          type: data.type,
          parent: data.parent,
          position: data.position
        });
        
        for (const po of data.permissionOverwrites) {
          await newChannel.permissionOverwrites.create(po.id, {
            allow: BigInt(po.allow),
            deny: BigInt(po.deny)
          });
        }
        logAction(`♻️ Restored channel #${data.name}`);
      }
    }
  }
  
  // ==== INTERACTIONS ====
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
  
    const { commandName } = interaction;
  
    // === STAFF MANAGEMENT COMMANDS ===
    if (commandName === "addstaff") {
      if (!isHeadStaff(interaction.user.id)) {
        return interaction.reply({ content: "❌ Only the bot owner and head staff can manage staff roles.", ephemeral: true });
      }
  
      const role = interaction.options.getRole("role");
      const added = addStaffRole(interaction.guild.id, role.id);
  
      if (added) {
        const embed = new EmbedBuilder()
          .setColor("Green")
          .setTitle("✅ Staff Role Added")
          .setDescription(`${role} has been added as a staff role.`)
          .addFields({ 
            name: "Members with this role can now:", 
            value: "• Use all moderation commands\n• See staff-only commands" 
          })
          .setFooter({ text: `Added by ${interaction.user.tag}` })
          .setTimestamp();
  
        interaction.reply({ embeds: [embed] });
        logAction(`✅ ${interaction.user.tag} added staff role: ${role.name}`);
      } else {
        interaction.reply({ content: `❌ ${role} is already a staff role.`, ephemeral: true });
      }
    }
  
    if (commandName === "removestaff") {
      if (!isHeadStaff(interaction.user.id)) {
        return interaction.reply({ content: "❌ Only the bot owner and head staff can manage staff roles.", ephemeral: true });
      }
  
      const role = interaction.options.getRole("role");
      const removed = removeStaffRole(interaction.guild.id, role.id);
  
      if (removed) {
        const embed = new EmbedBuilder()
          .setColor("Orange")
          .setTitle("🗑️ Staff Role Removed")
          .setDescription(`${role} has been removed from staff roles.`)
          .addFields({ 
            name: "Members with this role can no longer:", 
            value: "• Use moderation commands\n• See staff-only commands" 
          })
          .setFooter({ text: `Removed by ${interaction.user.tag}` })
          .setTimestamp();
  
        interaction.reply({ embeds: [embed] });
        logAction(`🗑️ ${interaction.user.tag} removed staff role: ${role.name}`);
      } else {
        interaction.reply({ content: `❌ ${role} is not a staff role.`, ephemeral: true });
      }
    }
  
    if (commandName === "liststaff") {
      if (!isHeadStaff(interaction.user.id)) {
        return interaction.reply({ content: "❌ Only the bot owner and head staff can view staff roles.", ephemeral: true });
      }
  
      const guildStaffRoles = staffRoles.get(interaction.guild.id) || [];
      
      if (guildStaffRoles.length === 0) {
        return interaction.reply({ content: "📋 No staff roles configured.", ephemeral: true });
      }
  
      const roleList = guildStaffRoles
        .map(roleId => {
          const role = interaction.guild.roles.cache.get(roleId);
          return role ? `• ${role.name} (${role.members.size} members)` : `• Unknown Role (${roleId})`;
        })
        .join("\n");
  
      // Add head staff info
      const headStaffList = HEAD_STAFF_IDS
        .map(id => {
          const user = client.users.cache.get(id);
          return user ? `• ${user.tag}` : `• Unknown User (${id})`;
        })
        .join("\n");
  
      const embed = new EmbedBuilder()
        .setColor("Blue")
        .setTitle("📋 Staff Configuration")
        .addFields(
          { 
            name: "🔹 Head Staff (can manage roles)", 
            value: `• ${client.users.cache.get(OWNER_ID)?.tag || 'Unknown Owner'} (Owner)\n${headStaffList}` 
          },
          { 
            name: "🔸 Staff Roles", 
            value: guildStaffRoles.length > 0 ? roleList : "None configured" 
          }
        )
        .setFooter({ text: `Total: ${guildStaffRoles.length} staff role(s)` })
        .setTimestamp();
  
      interaction.reply({ embeds: [embed], ephemeral: true });
    }
  
    // === MODERATION COMMANDS (Staff Only) ===
    // Check if user is staff for all moderation commands
    if (["ban", "kick", "mute", "unban", "warn", "restore"].includes(commandName)) {
      if (!isStaff(interaction.member)) {
        return interaction.reply({ 
          content: "❌ You don't have permission to use this command.", 
          ephemeral: true 
        });
      }
    }
  
    // === BAN ===
    if (commandName === "ban") {
      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason";
      
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: "❌ User not found.", ephemeral: true });
  
      // Staff can now be banned (removed staff protection)
      
      // Check bot permissions
      if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        return interaction.reply({ content: "❌ Bot doesn't have permission to ban members.", ephemeral: true });
      }
  
      try {
        await member.ban({ reason });
        
        const embed = new EmbedBuilder()
          .setColor("Red")
          .setTitle("🔨 Member Banned")
          .setDescription(`${target} has been banned.`)
          .addFields(
            { name: "Reason", value: reason },
            { name: "Moderator", value: interaction.user.toString() }
          )
          .setTimestamp();
  
        interaction.reply({ embeds: [embed] });
        logBanAction(`🔨 ${interaction.user.tag} banned ${target.tag} | ${reason}`);
        recordAction(interaction.user.id, { type: "ban", user: target.id });
      } catch (error) {
        console.error("Ban error:", error);
        interaction.reply({ content: "❌ Failed to ban user. Check permissions or user hierarchy.", ephemeral: true });
      }
    }
  
    // === KICK ===
    if (commandName === "kick") {
      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason";
      
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: "❌ User not found.", ephemeral: true });
  
      // Staff can now be kicked (removed staff protection)
  
      // Check bot permissions
      if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        return interaction.reply({ content: "❌ Bot doesn't have permission to kick members.", ephemeral: true });
      }
  
      try {
        await member.kick(reason);
        
        const embed = new EmbedBuilder()
          .setColor("Orange")
          .setTitle("👢 Member Kicked")
          .setDescription(`${target} has been kicked.`)
          .addFields(
            { name: "Reason", value: reason },
            { name: "Moderator", value: interaction.user.toString() }
          )
          .setTimestamp();
  
        interaction.reply({ embeds: [embed] });
        logBanAction(`👢 ${interaction.user.tag} kicked ${target.tag} | ${reason}`);
        recordAction(interaction.user.id, { type: "kick", user: target.id });
      } catch (error) {
        console.error("Kick error:", error);
        interaction.reply({ content: "❌ Failed to kick user. Check permissions or user hierarchy.", ephemeral: true });
      }
    }
  
    // === MUTE ===
    if (commandName === "mute") {
      const target = interaction.options.getUser("target");
      const minutes = interaction.options.getInteger("minutes");
      
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: "❌ User not found.", ephemeral: true });
  
      // Staff can now be muted (removed staff protection)
  
      if (minutes > 40320) { // Discord's max timeout is 28 days
        return interaction.reply({ content: "❌ Maximum mute duration is 40,320 minutes (28 days).", ephemeral: true });
      }
  
      // Check bot permissions
      if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return interaction.reply({ content: "❌ Bot doesn't have permission to timeout members.", ephemeral: true });
      }
  
      try {
        const duration = minutes * 60 * 1000;
        await member.timeout(duration, "Muted by command");
        
        const embed = new EmbedBuilder()
          .setColor("Yellow")
          .setTitle("🔇 Member Muted")
          .setDescription(`${target} has been muted.`)
          .addFields(
            { name: "Duration", value: `${minutes} minutes` },
            { name: "Moderator", value: interaction.user.toString() }
          )
          .setTimestamp();
  
        interaction.reply({ embeds: [embed] });
        logSecurityAction(`🔇 ${interaction.user.tag} muted ${target.tag} for ${minutes} minutes.`);
        recordAction(interaction.user.id, { type: "mute", user: target.id, duration });
      } catch (error) {
        console.error("Mute error:", error);
        interaction.reply({ content: "❌ Failed to mute user. Check permissions or user hierarchy.", ephemeral: true });
      }
    }
  
    // === UNBAN ===
    if (commandName === "unban") {
      const userId = interaction.options.getString("userid");
      
      try {
        await interaction.guild.members.unban(userId);
        await restoreChannels(interaction.guild);
        
        const embed = new EmbedBuilder()
          .setColor("Green")
          .setTitle("✅ User Unbanned")
          .setDescription(`<@${userId}> has been unbanned and channels restored.`)
          .addFields({ name: "Moderator", value: interaction.user.toString() })
          .setTimestamp();
  
        interaction.reply({ embeds: [embed] });
        logAction(`✅ ${interaction.user.tag} unbanned <@${userId}> and restored channels.`);
      } catch (error) {
        interaction.reply({ content: "❌ Failed to unban user. They might not be banned.", ephemeral: true });
      }
    }
  
    // === WARN ===
    if (commandName === "warn") {
      const target = interaction.options.getUser("target");
      const reason = interaction.options.getString("reason") || "No reason";
  
      // Staff can now be warned (removed staff protection)
      
      addWarning(target.id, interaction.guild.id, reason);
      
      const warnEmbed = new EmbedBuilder()
        .setColor("Red")
        .setTitle("⚠️ Warning Issued")
        .setDescription(`${target} has been warned.`)
        .addFields(
          { name: "Reason", value: reason },
          { name: "Moderator", value: interaction.user.toString() }
        )
        .setFooter({ text: `Total warnings: ${getWarningCount(target.id, interaction.guild.id)}` })
        .setTimestamp();
  
      interaction.reply({ embeds: [warnEmbed] });
      logWarnAction(`⚠️ ${interaction.user.tag} warned ${target.tag} | ${reason}`);
    }
  
    // === RESTORE ===
    if (commandName === "restore") {
      if (!isOwner(interaction.user.id)) {
        return interaction.reply({ content: "❌ Only the bot owner can use this command.", ephemeral: true });
      }
  
      const staff = interaction.options.getUser("staff");
      const staffActions = actionsLog.filter(a => a.staff === staff.id);
      
      if (staffActions.length === 0) {
        return interaction.reply({ content: "❌ No actions found for this staff member.", ephemeral: true });
      }
  
      let restoredCount = 0;
      for (let act of staffActions) {
        try {
          if (act.type === "ban") {
            await interaction.guild.members.unban(act.user);
            restoredCount++;
          }
          if (act.type === "mute") {
            const member = await interaction.guild.members.fetch(act.user).catch(() => null);
            if (member) {
              await member.timeout(null);
              restoredCount++;
            }
          }
        } catch (error) {
          console.error(`Failed to restore action: ${error}`);
        }
      }
  
      await restoreChannels(interaction.guild);
      
      const embed = new EmbedBuilder()
        .setColor("Purple")
        .setTitle("♻️ Actions Restored")
        .setDescription(`Restored ${restoredCount} actions by ${staff}.`)
        .addFields({ name: "Restored by", value: interaction.user.toString() })
        .setTimestamp();
  
      interaction.reply({ embeds: [embed] });
      logAction(`♻️ ${interaction.user.tag} restored ${restoredCount} actions by ${staff.tag}`);
    }
  });
  
  // ==== HELPERS ====
  function addWarning(userId, guildId, reason) {
    const key = `${guildId}-${userId}`;
    let userWarnings = warnings.get(key) || [];
    userWarnings.push({ reason, date: new Date() });
    warnings.set(key, userWarnings);
  }
  
  function getWarningCount(userId, guildId) {
    const key = `${guildId}-${userId}`;
    const userWarnings = warnings.get(key) || [];
    return userWarnings.length;
  }
  
  // Separate logging functions for different channels
  async function logSecurityAction(text, embed = null) {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (logChannel) {
      if (embed) {
        logChannel.send({ embeds: [embed] });
      } else {
        logChannel.send(text);
      }
    }
  }
  
  async function logWarnAction(text, embed = null) {
    const warnChannel = await client.channels.fetch(WARN_CHANNEL_ID).catch(() => null);
    if (warnChannel) {
      if (embed) {
        warnChannel.send({ embeds: [embed] });
      } else {
        warnChannel.send(text);
      }
    }
  }
  
  async function logBanAction(text, embed = null) {
    const banChannel = await client.channels.fetch(BAN_CHANNEL_ID).catch(() => null);
    if (banChannel) {
      if (embed) {
        banChannel.send({ embeds: [embed] });
      } else {
        banChannel.send(text);
      }
    }
  }
  
  function recordAction(staffId, action) {
    actionsLog.push({ staff: staffId, ...action });
  }
  
  // ==== LOGIN ====
  client.login(BOT_TOKEN);