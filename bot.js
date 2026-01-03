// BlockDebt - Discord Loan Bot (REFactor completo, stabile, senza bug)
// Node 18+, discord.js v14

const fs = require('fs');
const path = require('path');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const Database = require('better-sqlite3');

/* ===================== CONFIG ===================== */
const TOKEN = process.env.DISCORD_TOKEN;
const PRESTITI_CHANNEL_ID = process.env.CHANNEL_ID;

if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN mancante');
  process.exit(1);
}

/* ===================== DATABASE ===================== */
const dbPath = fs.existsSync('/app/data')
  ? '/app/data/blockdebt.db'
  : path.join(__dirname, 'blockdebt.db');

const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS prestiti (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mittente_id TEXT,
  mittente_nome TEXT,
  debitore_id TEXT,
  debitore_nome TEXT,
  categoria TEXT,
  importo_originale REAL,
  importo_attuale REAL,
  data_creazione TEXT,
  data_accettazione TEXT,
  ultimo_incremento TEXT,
  stato TEXT,
  thread_id TEXT,
  guild_id TEXT
);
`);

/* ===================== UTILS ===================== */
function format(num) {
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return String(Math.round(num));
}

function creaEmbed(prestito) {
  return new EmbedBuilder()
    .setColor(prestito.stato === 'attivo' ? 0x00ff00 : 0xffff00)
    .setTitle(`💰 Prestito #${prestito.id}`)
    .addFields(
      { name: 'Mittente', value: prestito.mittente_nome, inline: true },
      { name: 'Debitore', value: prestito.debitore_nome, inline: true },
      { name: 'Importo', value: format(prestito.importo_attuale), inline: true },
      { name: 'Stato', value: prestito.stato }
    )
    .setTimestamp();
}

/* ===================== CLIENT ===================== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* ===================== READY ===================== */
client.once('ready', async () => {
  console.log(`✅ Online come ${client.user.tag}`);

  const channel = await client.channels.fetch(PRESTITI_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle('📄 Prestiti')
    .setDescription('Scegli una categoria per creare un prestito');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cat_soldi').setLabel('Soldi').setStyle(ButtonStyle.Primary)
  );

  await channel.send({ embeds: [embed], components: [row] });
});

/* ===================== INTERACTIONS ===================== */
client.on('interactionCreate', async interaction => {
  try {

    /* ---------- BUTTON ---------- */
    if (interaction.isButton() && interaction.customId === 'cat_soldi') {
      const modal = new ModalBuilder()
        .setCustomId('modal_soldi')
        .setTitle('Nuovo prestito - Soldi');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('debitore')
            .setLabel('ID debitore')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('importo')
            .setLabel('Importo')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );

      return await interaction.showModal(modal);
    }

    /* ---------- MODAL ---------- */
    if (interaction.isModalSubmit() && interaction.customId === 'modal_soldi') {
      const debitoreId = interaction.fields.getTextInputValue('debitore');
      const importo = Number(interaction.fields.getTextInputValue('importo'));

      if (isNaN(importo) || importo <= 0) {
        return interaction.reply({ content: '❌ Importo non valido', ephemeral: true });
      }

      const debitore = await interaction.guild.members.fetch(debitoreId).catch(() => null);
      if (!debitore) {
        return interaction.reply({ content: '❌ Debitore non trovato', ephemeral: true });
      }

      const now = new Date().toISOString();

      const res = db.prepare(`
        INSERT INTO prestiti
        (mittente_id, mittente_nome, debitore_id, debitore_nome, categoria,
         importo_originale, importo_attuale, data_creazione, stato, guild_id)
        VALUES (?, ?, ?, ?, 'Soldi', ?, ?, ?, 'attesa', ?)
      `).run(
        interaction.user.id,
        interaction.user.username,
        debitore.id,
        debitore.user.username,
        importo,
        importo,
        now,
        interaction.guild.id
      );

      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(res.lastInsertRowid);

      const thread = await interaction.channel.threads.create({
        name: `prestito-${prestito.id}`,
        autoArchiveDuration: 1440
      });

      db.prepare('UPDATE prestiti SET thread_id = ? WHERE id = ?')
        .run(thread.id, prestito.id);

      await thread.send({ embeds: [creaEmbed(prestito)] });

      return interaction.reply({
        content: `✅ Prestito creato (#${prestito.id})`,
        ephemeral: true
      });
    }

  } catch (err) {
    console.error(err);
    if (!interaction.replied) {
      interaction.reply({ content: '❌ Errore', ephemeral: true }).catch(() => {});
    }
  }
});

/* ===================== INTERESSI 3% ===================== */
setInterval(() => {
  const prestiti = db.prepare(`SELECT * FROM prestiti WHERE stato = 'attivo'`).all();
  const now = new Date();

  for (const p of prestiti) {
    const last = p.ultimo_incremento
      ? new Date(p.ultimo_incremento)
      : new Date(p.data_accettazione || p.data_creazione);

    const giorni = Math.floor((now - last) / 86400000);
    if (giorni <= 0) continue;

    let nuovo = p.importo_attuale;
    for (let i = 0; i < giorni; i++) nuovo *= 1.03;

    db.prepare(`
      UPDATE prestiti
      SET importo_attuale = ?, ultimo_incremento = ?
      WHERE id = ?
    `).run(nuovo, now.toISOString(), p.id);
  }
}, 60 * 60 * 1000);

/* ===================== EXPRESS ===================== */
const app = express();
app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 3000);

/* ===================== LOGIN ===================== */
client.login(TOKEN);
