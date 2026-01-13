// ================================
// BlockDebt — FIXATO E RIORDINATO
// ================================
// Requisiti: npm install discord.js better-sqlite3 express
// ================================

const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

// ================================
// COSTANTI
// ================================
const MULTIPLIERS = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
  t: 1_000_000_000_000,
};

const MAX_MONEY = 10 * MULTIPLIERS.t;
const MAX_ITEMS = 10 * MULTIPLIERS.t;
const STACK_SIZE = 64;
const MAX_STACKS = 150_000_000_000;

// ================================
// FUNZIONI UTILITÀ
// ================================

// NORMALIZZA INPUT SOLDI
function normalizeMoneyInput(input) {
  if (!input) return null;
  
  let raw = input.toLowerCase().replace(/,/g, '').trim();
  if (!/^[0-9.]+[kmbt]?$/.test(raw)) return null;

  let suffix = raw.match(/[kmbt]$/)?.[0] || '';
  let num = parseFloat(raw.replace(/[kmbt]/, ''));

  if (isNaN(num)) return null;

  let value = num * (MULTIPLIERS[suffix] || 1);

  // AUTOCORREZIONE (1000k → 1m, 100000k → 100m)
  if (suffix && num >= 1000) {
    const keys = Object.keys(MULTIPLIERS);
    const idx = keys.indexOf(suffix);
    if (idx < keys.length - 1) {
      value = (num / 1000) * MULTIPLIERS[keys[idx + 1]];
    }
  }

  if (value > MAX_MONEY) return null;

  return { value, pretty: formatMoney(value), raw };
}

// PARSE SOLDI
function parseMoney(input) {
  const parsed = normalizeMoneyInput(input);
  if (!parsed) throw new Error('Importo non valido');
  return parsed.value;
}

// FORMATTA SOLDI
function formatMoney(value) {
  if (value >= MULTIPLIERS.t) return (value / MULTIPLIERS.t).toFixed(2).replace(/\.?0+$/, '') + 'T';
  if (value >= MULTIPLIERS.b) return (value / MULTIPLIERS.b).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (value >= MULTIPLIERS.m) return (value / MULTIPLIERS.m).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (value >= MULTIPLIERS.k) return (value / MULTIPLIERS.k).toFixed(2).replace(/\.?0+$/, '') + 'K';
  return value.toFixed(2);
}

// ITEM → UNITÀ
function parseItemStack(stackInput, extraInput) {
  const stacks = Number(stackInput);
  const extra = Number(extraInput || 0);

  if (!Number.isInteger(stacks) || stacks < 0) throw new Error('Stack non validi');
  if (!Number.isInteger(extra) || extra < 0 || extra > 63) throw new Error('Extra item 0-63');
  if (stacks > MAX_STACKS) throw new Error('Troppi stack');

  const total = stacks * STACK_SIZE + extra;
  if (total > MAX_ITEMS) throw new Error('Superato limite item');

  return total;
}

// UNITÀ → STACK
function unitToStack(totalUnits) {
  const stacks = Math.floor(totalUnits / STACK_SIZE);
  const rest = totalUnits % STACK_SIZE;
  return { stacks, rest };
}

// FORMATTA ITEM DISPLAY
function formatItemDisplay(units) {
  const rounded = Math.floor(units + 0.5); // arrotondamento
  const { stacks, rest } = unitToStack(rounded);
  return {
    unit: `${rounded} unità`,
    stack: `${stacks} stack${rest > 0 ? ` + ${rest}` : ''}`,
  };
}

// PARSE KILL
function parseKill(input) {
  if (!input) throw new Error('Kill mancanti');
  const n = Number(input);
  if (isNaN(n) || n < 0) throw new Error('Numero non valido');
  if (n > 10_000) throw new Error('Massimo 10.000 kill');
  return n;
}

// INTERESSE 3%
function applyInterest(value) {
  return value + (value * 0.03);
}

// CALCOLA INTERESSI GIORNALIERI
function calculateInterest(baseValue, days) {
  let value = baseValue;
  for (let i = 0; i < days; i++) {
    value = applyInterest(value);
  }
  return value;
}

// ARROTONDAMENTO DISPLAY
function roundForDisplay(n) {
  const dec = n - Math.floor(n);
  return dec >= 0.5 ? Math.ceil(n) : Math.floor(n);
}

// ================================
// CONFIG
// ================================
const CONFIG = {
  TOKEN: process.env.DISCORD_TOKEN,
  PRESTITI_CHANNEL_ID: process.env.CHANNEL_ID || '1456768128880082995',
};

if (!CONFIG.TOKEN) {
  console.error('❌ DISCORD_TOKEN mancante');
  process.exit(1);
}

// ================================
// DATABASE
// ================================
const dbPath = fs.existsSync('/app/data')
  ? '/app/data/blockdebt.db'
  : path.join(__dirname, 'blockdebt.db');

const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS prestiti (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  categoria TEXT NOT NULL,
  mittente_id TEXT NOT NULL,
  mittente_nome TEXT NOT NULL,
  debitore_id TEXT NOT NULL,
  debitore_nome TEXT NOT NULL,
  importo_originale REAL NOT NULL,
  importo_attuale REAL NOT NULL,
  stato TEXT NOT NULL,
  thread_id TEXT,
  data_creazione TEXT NOT NULL,
  data_accettazione TEXT,
  ultimo_incremento TEXT
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS pagamenti (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prestito_id INTEGER NOT NULL,
  importo REAL NOT NULL,
  data TEXT NOT NULL,
  FOREIGN KEY (prestito_id) REFERENCES prestiti(id)
);
`);

// ================================
// FUNZIONI EMBED E ROW
// ================================

// EMBED PRESTITO
function creaEmbedPrestito(prestito) {
  const now = new Date();
  let giorni = 0;

  if (prestito.data_accettazione && prestito.stato === 'attivo') {
    const last = prestito.ultimo_incremento
      ? new Date(prestito.ultimo_incremento)
      : new Date(prestito.data_accettazione);
    giorni = Math.floor((now - last) / (1000 * 60 * 60 * 24));
  }

  let attuale = prestito.importo_attuale;
  if (prestito.stato === 'attivo' && giorni > 0) {
    attuale = calculateInterest(attuale, giorni);
  }

  const embed = new EmbedBuilder()
    .setColor(prestito.stato === 'attivo' ? 0x00ff00 : prestito.stato === 'declinato' ? 0xff0000 : 0xffff00)
    .setTitle(`📄 Prestito #${prestito.id} — ${prestito.categoria}`)
    .addFields(
      { name: '🟢 Mittente', value: prestito.mittente_nome, inline: true },
      { name: '🔴 Debitore', value: prestito.debitore_nome, inline: true },
      { name: '📌 Stato', value: prestito.stato.toUpperCase(), inline: true }
    )
    .setTimestamp();

  // SOLDI
  if (prestito.categoria === 'Soldi') {
    embed.addFields(
      { name: '💰 Originale', value: formatMoney(prestito.importo_originale), inline: true },
      { name: '🔄 Attuale', value: formatMoney(attuale), inline: true }
    );
  }

  // ITEM
  if (prestito.categoria === 'Item') {
    const orig = formatItemDisplay(prestito.importo_originale);
    const curr = formatItemDisplay(attuale);
    embed.addFields(
      { name: '📦 Originale', value: `${orig.unit}\n${orig.stack}`, inline: true },
      { name: '🔄 Attuale', value: `${curr.unit}\n${curr.stack}`, inline: true }
    );
  }

  // KILL
  if (prestito.categoria === 'Kill') {
    embed.addFields(
      { name: '☠ Originali', value: prestito.importo_originale.toString(), inline: true },
      { name: '🔄 Attuali', value: roundForDisplay(attuale).toString(), inline: true }
    );
  }

  // INFO
  if (prestito.categoria === 'Info') {
    embed.addFields({ name: 'ℹ Info', value: prestito.importo_originale.toString().substring(0, 1000) || '—' });
  }

  return embed;
}

// ROWS BOTTONI
function buildAcceptRow(prestitoId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`prestito_accetta_${prestitoId}`).setLabel('✅ Accetta').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`prestito_rifiuta_${prestitoId}`).setLabel('❌ Rifiuta').setStyle(ButtonStyle.Danger)
  );
}

function buildUpdateRow(prestitoId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`prestito_aggiorna_${prestitoId}`).setLabel('🔄 Aggiorna calcoli').setStyle(ButtonStyle.Secondary)
  );
}

function buildPaymentRow(prestitoId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`prestito_paga_${prestitoId}`).setLabel('💸 Paga').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`prestito_chiudi_${prestitoId}`).setLabel('🔒 Chiudi').setStyle(ButtonStyle.Secondary)
  );
}

function buildCloseConfirmRow(prestitoId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`prestito_chiudi_confirm_${prestitoId}`).setLabel('⚠ Conferma chiusura').setStyle(ButtonStyle.Danger)
  );
}

// THREAD CREATION
async function createLoanThread(channel, prestito) {
  const thread = await channel.threads.create({
    name: `Prestito #${prestito.id}`,
    autoArchiveDuration: 1440,
  });

  db.prepare('UPDATE prestiti SET thread_id = ? WHERE id = ?').run(thread.id, prestito.id);

  await thread.send({
    embeds: [creaEmbedPrestito(prestito)],
    components: [buildAcceptRow(prestito.id)],
  });

  return thread;
}

// AGGIORNA EMBED NEL THREAD
async function aggiornaEmbedThread(client, prestitoId) {
  const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
  if (!prestito || !prestito.thread_id) return;

  const thread = await client.channels.fetch(prestito.thread_id).catch(() => null);
  if (!thread) return;

  const msgs = await thread.messages.fetch({ limit: 1 }).catch(() => null);
  const first = msgs?.first();
  if (!first) return;

  const components = [];
  if (prestito.stato === 'attivo') {
    components.push(buildUpdateRow(prestitoId), buildPaymentRow(prestitoId));
  }

  await first.edit({ embeds: [creaEmbedPrestito(prestito)], components }).catch(() => null);
}

// APPLICA INTERESSI
function applicaInteressi(prestito) {
  if (prestito.stato !== 'attivo') return false;

  const now = new Date();
  const last = prestito.ultimo_incremento
    ? new Date(prestito.ultimo_incremento)
    : new Date(prestito.data_accettazione);

  const msGiorno = 24 * 60 * 60 * 1000;
  const giorniPassati = Math.floor((now - last) / msGiorno);

  if (giorniPassati <= 0) return false;

  const nuovoImporto = calculateInterest(prestito.importo_attuale, giorniPassati);

  db.prepare(`
    UPDATE prestiti
    SET importo_attuale = ?, ultimo_incremento = ?
    WHERE id = ?
  `).run(nuovoImporto, now.toISOString(), prestito.id);

  return { giorni: giorniPassati, nuovoImporto };
}

// ================================
// CLIENT
// ================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ================================
// READY
// ================================
client.once('ready', async () => {
  console.log(`✅ BlockDebt online come ${client.user.tag}`);

  const channel = await client.channels.fetch(CONFIG.PRESTITI_CHANNEL_ID).catch(() => null);
  if (!channel) return console.warn('Canale prestiti non trovato');

  const embed = new EmbedBuilder()
    .setColor('#3498db')
    .setTitle('📄 Prestiti')
    .setDescription('Scegli una categoria per avviare un prestito');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cat_soldi').setLabel('Soldi').setEmoji('💰').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cat_item').setLabel('Item').setEmoji('📦').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cat_kill').setLabel('Kill').setEmoji('☠').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cat_info').setLabel('Info').setEmoji('ℹ').setStyle(ButtonStyle.Secondary),
  );

  await channel.send({ embeds: [embed], components: [row] }).catch(() => {});
});

// ================================
// UN SOLO INTERACTION LISTENER
// ================================
client.on('interactionCreate', async (interaction) => {
  try {
    // ===== BOTTONE CATEGORIA =====
    if (interaction.isButton() && interaction.customId.startsWith('cat_')) {
      const categoria = interaction.customId.replace('cat_', '');

      // MODALE SOLDI
      if (categoria === 'soldi') {
        const modal = new ModalBuilder()
          .setCustomId('modal_soldi')
          .setTitle('💰 Nuovo prestito — Soldi');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('importo')
              .setLabel('Importo (es: 1.5m, 200k, 1500000)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Max 10T')
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('debitore')
              .setLabel('ID o @ del debitore')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );

        return interaction.showModal(modal);
      }

      // MODALE ITEM
      if (categoria === 'item') {
        const modal = new ModalBuilder()
          .setCustomId('modal_item')
          .setTitle('📦 Nuovo prestito — Item');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('stack')
              .setLabel('Numero di stack')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('extra')
              .setLabel('Item extra (0-63)')
              .setStyle(TextInputStyle.Short)
              .setValue('0')
              .setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('debitore')
              .setLabel('ID o @ del debitore')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );

        return interaction.showModal(modal);
      }

      // MODALE KILL
      if (categoria === 'kill') {
        const modal = new ModalBuilder()
          .setCustomId('modal_kill')
          .setTitle('☠ Nuovo prestito — Kill');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('numero')
              .setLabel('Numero di kill')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Max 10.000')
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('debitore')
              .setLabel('ID o @ del debitore')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );

        return interaction.showModal(modal);
      }

      // MODALE INFO
      if (categoria === 'info') {
        const modal = new ModalBuilder()
          .setCustomId('modal_info')
          .setTitle('ℹ Nuovo prestito — Info');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('testo')
              .setLabel('Informazioni')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('debitore')
              .setLabel('ID o @ del debitore')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );

        return interaction.showModal(modal);
      }
    }

    // ===== SUBMIT MODALE SOLDI =====
    if (interaction.isModalSubmit() && interaction.customId === 'modal_soldi') {
      const input = interaction.fields.getTextInputValue('importo');
      const debitoreRaw = interaction.fields.getTextInputValue('debitore');

      let valore;
      try {
        valore = parseMoney(input);
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }

      const debitoreId = debitoreRaw.replace(/[<@!>]/g, '');
      const debitore = await interaction.guild.members.fetch(debitoreId).catch(() => null);
      if (!debitore) {
        return interaction.reply({ content: '❌ Debitore non trovato.', ephemeral: true });
      }

      const stmt = db.prepare(`
        INSERT INTO prestiti
        (mittente_id, mittente_nome, debitore_id, debitore_nome,
         categoria, importo_originale, importo_attuale,
         data_creazione, stato, guild_id)
        VALUES (?, ?, ?, ?, 'Soldi', ?, ?, ?, 'attesa', ?)
      `);

      const res = stmt.run(
        interaction.user.id,
        interaction.user.username,
        debitore.id,
        debitore.user.username,
        valore,
        valore,
        new Date().toISOString(),
        interaction.guild.id
      );

      await interaction.reply({ content: '✅ Prestito creato!', ephemeral: true });

      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(res.lastInsertRowid);
      await createLoanThread(interaction.channel, prestito);
    }

    // ===== SUBMIT MODALE ITEM =====
    if (interaction.isModalSubmit() && interaction.customId === 'modal_item') {
      const stackInput = interaction.fields.getTextInputValue('stack');
      const extraInput = interaction.fields.getTextInputValue('extra') || '0';
      const debitoreRaw = interaction.fields.getTextInputValue('debitore');

      let totalUnits;
      try {
        totalUnits = parseItemStack(stackInput, extraInput);
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }

      const debitoreId = debitoreRaw.replace(/[<@!>]/g, '');
      const debitore = await interaction.guild.members.fetch(debitoreId).catch(() => null);
      if (!debitore) {
        return interaction.reply({ content: '❌ Debitore non trovato.', ephemeral: true });
      }

      const stmt = db.prepare(`
        INSERT INTO prestiti
        (mittente_id, mittente_nome, debitore_id, debitore_nome,
         categoria, importo_originale, importo_attuale,
         data_creazione, stato, guild_id)
        VALUES (?, ?, ?, ?, 'Item', ?, ?, ?, 'attesa', ?)
      `);

      const res = stmt.run(
        interaction.user.id,
        interaction.user.username,
        debitore.id,
        debitore.user.username,
        totalUnits,
        totalUnits,
        new Date().toISOString(),
        interaction.guild.id
      );

      await interaction.reply({ content: '✅ Prestito creato!', ephemeral: true });

      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(res.lastInsertRowid);
      await createLoanThread(interaction.channel, prestito);
    }

    // ===== SUBMIT MODALE KILL =====
    if (interaction.isModalSubmit() && interaction.customId === 'modal_kill') {
      const numeroInput = interaction.fields.getTextInputValue('numero');
      const debitoreRaw = interaction.fields.getTextInputValue('debitore');

      let numero;
      try {
        numero = parseKill(numeroInput);
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }

      const debitoreId = debitoreRaw.replace(/[<@!>]/g, '');
      const debitore = await interaction.guild.members.fetch(debitoreId).catch(() => null);
      if (!debitore) {
        return interaction.reply({ content: '❌ Debitore non trovato.', ephemeral: true });
      }

      const stmt = db.prepare(`
        INSERT INTO prestiti
        (mittente_id, mittente_nome, debitore_id, debitore_nome,
         categoria, importo_originale, importo_attuale,
         data_creazione, stato, guild_id)
        VALUES (?, ?, ?, ?, 'Kill', ?, ?, ?, 'attesa', ?)
      `);

      const res = stmt.run(
        interaction.user.id,
        interaction.user.username,
        debitore.id,
        debitore.user.username,
        numero,
        numero,
        new Date().toISOString(),
        interaction.guild.id
      );

      await interaction.reply({ content: '✅ Prestito creato!', ephemeral: true });

      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(res.lastInsertRowid);
      await createLoanThread(interaction.channel, prestito);
    }

    // ===== SUBMIT MODALE INFO =====
    if (interaction.isModalSubmit() && interaction.customId === 'modal_info') {
      const testo = interaction.fields.getTextInputValue('testo');
      const debitoreRaw = interaction.fields.getTextInputValue('debitore');

      const debitoreId = debitoreRaw.replace(/[<@!>]/g, '');
      const debitore = await interaction.guild.members.fetch(debitoreId).catch(() => null);
      if (!debitore) {
        return interaction.reply({ content: '❌ Debitore non trovato.', ephemeral: true });
      }

      const stmt = db.prepare(`
        INSERT INTO prestiti
        (mittente_id, mittente_nome, debitore_id, debitore_nome,
         categoria, importo_originale, importo_attuale,
         data_creazione, stato, guild_id)
        VALUES (?, ?, ?, ?, 'Info', ?, ?, ?, 'attesa', ?)
      `);

      const res = stmt.run(
        interaction.user.id,
        interaction.user.username,
        debitore.id,
        debitore.user.username,
        testo,
        testo,
        new Date().toISOString(),
        interaction.guild.id
      );

      await interaction.reply({ content: '✅ Prestito creato!', ephemeral: true });

      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(res.lastInsertRowid);
      await createLoanThread(interaction.channel, prestito);
    }

    // ===== ACCETTA PRESTITO =====
    if (interaction.isButton() && interaction.customId.startsWith('prestito_accetta_')) {
      const prestitoId = interaction.customId.split('_')[2];
      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
      if (!prestito) {
        return interaction.reply({ content: '❌ Prestito non trovato.', ephemeral: true });
      }

      if (interaction.user.id !== prestito.debitore_id) {
        return interaction.reply({ content: '❌ Solo il debitore può accettare.', ephemeral: true });
      }

      if (prestito.stato !== 'attesa') {
        return interaction.reply({ content: '⚠ Prestito già gestito.', ephemeral: true });
      }

      const now = new Date().toISOString();

      db.prepare(`
        UPDATE prestiti
        SET stato = 'attivo',
            data_accettazione = ?,
            ultimo_incremento = ?
        WHERE id = ?
      `).run(now, now, prestitoId);

      await interaction.update({ content: '✅ Prestito ACCETTATO. Il 3% giornaliero è ora attivo.', components: [] });
      await aggiornaEmbedThread(client, prestitoId);
    }

    // ===== RIFIUTA PRESTITO =====
    if (interaction.isButton() && interaction.customId.startsWith('prestito_rifiuta_')) {
      const prestitoId = interaction.customId.split('_')[2];
      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
      if (!prestito) {
        return interaction.reply({ content: '❌ Prestito non trovato.', ephemeral: true });
      }

      if (interaction.user.id !== prestito.debitore_id) {
        return interaction.reply({ content: '❌ Solo il debitore può rifiutare.', ephemeral: true });
      }

      if (prestito.stato !== 'attesa') {
        return interaction.reply({ content: '⚠ Prestito già gestito.', ephemeral: true });
      }

      db.prepare('UPDATE prestiti SET stato = ? WHERE id = ?').run('declinato', prestitoId);

      await interaction.update({ content: '❌ Prestito RIFIUTATO.', components: [] });

      const thread = await interaction.channel.fetch().catch(() => null);
      if (thread && thread.isThread()) {
        await thread.setArchived(true).catch(() => null);
      }
    }

    // ===== AGGIORNA CALCOLI (🔄) =====
    if (interaction.isButton() && interaction.customId.startsWith('prestito_aggiorna_')) {
      const prestitoId = interaction.customId.split('_')[2];
      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);

      if (!prestito) {
        return interaction.reply({ content: '❌ Prestito non trovato.', ephemeral: true });
      }

      // ENTRAMBI mittente e debitore possono aggiornare
      if (![prestito.mittente_id, prestito.debitore_id].includes(interaction.user.id)) {
        return interaction.reply({ content: '❌ Non sei autorizzato.', ephemeral: true });
      }

      const risultato = applicaInteressi(prestito);

      if (!risultato) {
        return interaction.reply({ content: '⏳ Nessun aggiornamento disponibile.', ephemeral: true });
      }

      await interaction.reply({
        content: `🔄 Aggiornato di **${risultato.giorni} giorno/i** (+3% giornaliero).`,
        ephemeral: true
      });

      await aggiornaEmbedThread(client, prestitoId);
    }

    // ===== PAGA (modale) =====
    if (interaction.isButton() && interaction.customId.startsWith('prestito_paga_')) {
      const prestitoId = interaction.customId.split('_')[2];
      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
      if (!prestito) {
        return interaction.reply({ content: '❌ Prestito non trovato.', ephemeral: true });
      }

      if (interaction.user.id !== prestito.debitore_id) {
        return interaction.reply({ content: '❌ Solo il debitore può pagare.', ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId(`modal_paga_${prestito.id}`)
        .setTitle('Pagamento prestito');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('importo')
            .setLabel('Importo da pagare')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Es: 500k, 1.2m')
            .setRequired(true)
        )
      );

      await interaction.showModal(modal);
    }

    // ===== SUBMIT PAGAMENTO =====
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_paga_')) {
      const prestitoId = interaction.customId.split('_')[2];
      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
      if (!prestito) {
        return interaction.reply({ content: '❌ Prestito non trovato.', ephemeral: true });
      }

      const input = interaction.fields.getTextInputValue('importo');
      let valore;

      try {
        valore = parseMoney(input);
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }

      if (valore <= 0) {
        return interaction.reply({ content: '❌ Importo non valido.', ephemeral: true });
      }

      if (valore > prestito.importo_attuale) {
        return interaction.reply({ content: '❌ Non puoi pagare più del residuo.', ephemeral: true });
      }

      const nuovoResiduo = prestito.importo_attuale - valore;

      db.prepare('INSERT INTO pagamenti (prestito_id, importo, data) VALUES (?, ?, ?)').run(
        prestito.id,
        valore,
        new Date().toISOString()
      );

      db.prepare('UPDATE prestiti SET importo_attuale = ? WHERE id = ?').run(nuovoResiduo, prestito.id);

      await interaction.reply({
        content: `💸 Pagamento registrato: **${formatMoney(valore)}**`,
        ephemeral: true
      });

      // chiusura automatica se zero
      if (nuovoResiduo <= 0.001) {
        db.prepare('UPDATE prestiti SET stato = ? WHERE id = ?').run('completato', prestito.id);
      }

      await aggiornaEmbedThread(client, prestito.id);
    }

    // ===== CHIUDI (richiesta conferma) =====
    if (interaction.isButton() && interaction.customId.startsWith('prestito_chiudi_') && !interaction.customId.includes('confirm')) {
      const prestitoId = interaction.customId.split('_')[2];
      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
      if (!prestito) {
        return interaction.reply({ content: '❌ Prestito non trovato.', ephemeral: true });
      }

      if (![prestito.mittente_id, prestito.debitore_id].includes(interaction.user.id)) {
        return interaction.reply({ content: '❌ Non puoi chiudere questo prestito.', ephemeral: true });
      }

      await interaction.reply({
        content: '⚠ Confermi la chiusura definitiva?',
        components: [buildCloseConfirmRow(prestito.id)],
        ephemeral: true
      });
    }

    // ===== CONFERMA CHIUSURA =====
    if (interaction.isButton() && interaction.customId.startsWith('prestito_chiudi_confirm_')) {
      const prestitoId = interaction.customId.split('_')[3];
      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
      if (!prestito) {
        return interaction.reply({ content: '❌ Prestito non trovato.', ephemeral: true });
      }

      db.prepare('UPDATE prestiti SET stato = ? WHERE id = ?').run('chiuso', prestito.id);

      if (prestito.thread_id) {
        const thread = await client.channels.fetch(prestito.thread_id).catch(() => null);
        if (thread) {
          await thread.send('🔒 Prestito chiuso definitivamente.');
          await thread.setLocked(true).catch(() => null);
          await thread.setArchived(true).catch(() => null);
        }
      }

      await interaction.update({ content: '🔒 Prestito chiuso.', components: [] });
    }
  } catch (err) {
    console.error('Errore interaction:', err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Errore interno.', ephemeral: true });
      }
    } catch {}
  }
});

// ================================
// TIMER INTERESSI AUTOMATICI
// ================================
setInterval(() => {
  const prestiti = db.prepare('SELECT * FROM prestiti WHERE stato = ?').all('attivo');
  for (const prestito of prestiti) {
    applicaInteressi(prestito);
  }
}, 60 * 60 * 1000); // ogni ora

// ================================
// EXPRESS (RENDER)
// ================================
const app = express();
app.get('/', (_, res) => res.json({ status: 'online', bot: client.user?.tag || 'starting' }));
app.get('/health', (_, res) => res.json({ status: 'healthy' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Express su ${PORT}`));

// ================================
// LOGIN
// ================================
client.login(CONFIG.TOKEN);