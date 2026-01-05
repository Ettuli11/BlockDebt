// ================================
// BlockDebt — FASE 1 RIPULITA
// ================================
// Requisiti:
// npm install discord.js better-sqlite3 express
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
// NUMERIC ENGINE — FASE 2
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

// -------------------------------
// NORMALIZZA STRINGA NUMERICA
// -------------------------------
function parseAmount(input, max) {
  if (!input) throw new Error('Vuoto');

  input = input.trim().toLowerCase();

  if (input.includes(',')) {
    throw new Error('Usa il punto, non la virgola');
  }

  const match = input.match(/^(\d+(\.\d+)?)([kmbt])?$/);
  if (!match) throw new Error('Formato non valido');

  let value = parseFloat(match[1]);
  const suffix = match[3];

  if (suffix) {
    value *= MULTIPLIERS[suffix];
  }

  // AUTOCORREZIONE
  for (const [s, mult] of Object.entries(MULTIPLIERS)) {
    if (value >= mult * 1000 && s !== 't') {
      value = value / mult;
      value = value * MULTIPLIERS[
        Object.keys(MULTIPLIERS)[
          Object.keys(MULTIPLIERS).indexOf(s) + 1
        ]
      ];
    }
  }

  if (value > max) throw new Error('Valore troppo grande');

  return value;
}

// -------------------------------
// FORMATTA SOLDI
// -------------------------------
function formatMoney(value) {
  if (value >= MULTIPLIERS.t) return (value / MULTIPLIERS.t).toFixed(2) + 'T';
  if (value >= MULTIPLIERS.b) return (value / MULTIPLIERS.b).toFixed(2) + 'B';
  if (value >= MULTIPLIERS.m) return (value / MULTIPLIERS.m).toFixed(2) + 'M';
  if (value >= MULTIPLIERS.k) return (value / MULTIPLIERS.k).toFixed(2) + 'K';
  return value.toFixed(2);
}

// -------------------------------
// ITEM → UNITÀ
// -------------------------------
function parseItems({ mode, stacks, units }) {
  let total = 0;

  if (mode === 'stack') {
    if (stacks > MAX_STACKS) throw new Error('Troppi stack');
    if (units < 0 || units >= STACK_SIZE) throw new Error('Item extra non validi');
    total = stacks * STACK_SIZE + units;
  } else {
    total = parseAmount(units, MAX_ITEMS);
  }

  if (total > MAX_ITEMS) throw new Error('Troppi item');
  return total;
}

// -------------------------------
// UNITÀ → STACK
// -------------------------------
function toStacks(totalUnits) {
  const stacks = Math.floor(totalUnits / STACK_SIZE);
  const rest = totalUnits % STACK_SIZE;
  return { stacks, rest };
}

// -------------------------------
// INTERESSE 3%
// -------------------------------
function applyInterest(value) {
  return value + (value * 0.03);
}

module.exports = {
  parseAmount,
  formatMoney,
  parseItems,
  toStacks,
  applyInterest,
};


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
  creato_il TEXT NOT NULL
);
`);

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
// INTERACTIONS
// ================================
client.on('interactionCreate', async (interaction) => {
  try {

// ================================
// FASE 3 — SOLDI (MODALE + VALIDAZIONE)
// ================================

// ---- helpers SOLDI ----
const MONEY_LIMIT = 10_000_000_000_000; // 10T

function normalizeMoneyInput(input) {
  let raw = input.toLowerCase().replace(/,/g, '').trim();
  if (!/^[0-9.]+[kmbt]?$/.test(raw)) return null;

  let suffix = raw.match(/[kmbt]$/)?.[0] || '';
  let num = parseFloat(raw.replace(/[kmbt]/, ''));

  if (isNaN(num)) return null;

  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  let value = num * (mult[suffix] || 1);

  // autocorrezione tipo 1000k → 1m
  if (suffix && num >= 1000) {
    value = value;
  }

  if (value > MONEY_LIMIT) return null;

  return {
    value,
    pretty: formattaNumero(value),
    raw
  };
}

// ---- BUTTON SOLDI ----
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'cat_soldi') {
    const modal = new ModalBuilder()
      .setCustomId('modal_soldi')
      .setTitle('💰 Crea prestito - Soldi');

    const amountInput = new TextInputBuilder()
      .setCustomId('soldi_importo')
      .setLabel('Importo (es: 1.5m, 150k, 1000)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('Numeri + k m b t (max 10T)');

    modal.addComponents(
      new ActionRowBuilder().addComponents(amountInput)
    );

    return interaction.showModal(modal);
  }
});

// ---- SUBMIT MODALE SOLDI ----
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isModalSubmit()) return;

  if (interaction.customId === 'modal_soldi') {
    const input = interaction.fields.getTextInputValue('soldi_importo');
    const parsed = normalizeMoneyInput(input);

    if (!parsed) {
      return interaction.reply({
        content: '❌ Importo non valido.\nUsa numeri + . e k m b t (max 10T)',
        ephemeral: true
      });
    }

    // AUTOCORREZIONE VISIVA
    const corrected = parsed.raw !== parsed.pretty;

    const embed = new EmbedBuilder()
      .setColor('#00ff99')
      .setTitle('💰 Prestito Soldi — Anteprima')
      .addFields(
        { name: 'Valore inserito', value: input, inline: true },
        { name: 'Valore calcolato', value: `${parsed.value}`, inline: true },
        { name: 'Formato', value: parsed.pretty, inline: true },
      )
      .setFooter({ text: corrected ? 'Input corretto automaticamente' : 'Valore valido' });

    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
});


    // ----------------------------
    // CATEGORIA
    // ----------------------------
    if (interaction.isButton() && interaction.customId.startsWith('cat_')) {
      const categoria = interaction.customId.replace('cat_', '');

      const modal = new ModalBuilder()
        .setCustomId(`crea_${categoria}`)
        .setTitle(`Nuovo prestito — ${categoria}`);

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('debitore')
            .setLabel('Debitore (ID Discord)')
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

      await interaction.showModal(modal);
      return;
    }

// ================================
// FASE 4A – PARSER & VALIDATION
// ================================

const MULTIPLIERS = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
  t: 1_000_000_000_000,
};

const MAX_SOLDI = 10 * MULTIPLIERS.t;
const MAX_ITEMS = 10 * MULTIPLIERS.t;
const MAX_STACK = 150_000_000_000;
const STACK_SIZE = 64;

// --------------------
// UTIL
// --------------------
function roundForDisplay(n) {
  const dec = n - Math.floor(n);
  return dec >= 0.5 ? Math.ceil(n) : Math.floor(n);
}

function apply3Percent(base) {
  return base + (base * 3) / 100;
}

// --------------------
// SOLDI
// --------------------
function parseMoney(input) {
  if (!input) throw new Error('Importo mancante');

  input = input.trim().toLowerCase();
  if (input.includes(',')) throw new Error('Usa il punto (.) e non la virgola');

  const match = input.match(/^(\d+(\.\d+)?)([kmbt])?$/i);
  if (!match) throw new Error('Formato non valido');

  let value = parseFloat(match[1]);
  let suffix = match[3]?.toLowerCase();

  if (suffix) value *= MULTIPLIERS[suffix];

  // autocorrezioni tipo 1000k -> 1m
  for (const [key, mult] of Object.entries(MULTIPLIERS)) {
    if (value >= mult * 1000) {
      value = value / 1000;
      suffix = key;
    }
  }

  if (value > MAX_SOLDI) throw new Error('Superato limite massimo (10T)');

  return {
    raw: input,
    value,
    normalized: suffix ? `${value}${suffix}` : `${value}`,
  };
}

// --------------------
// ITEM
// --------------------
function parseItemUnit(input) {
  const money = parseMoney(input);
  if (money.value > MAX_ITEMS) throw new Error('Troppi item');
  return money.value;
}

function parseItemStack(stackInput, extraInput) {
  const stacks = parseMoney(stackInput).value;
  const extra = Number(extraInput ?? 0);

  if (extra < 0 || extra > 63) throw new Error('Extra item non valido');
  if (stacks > MAX_STACK) throw new Error('Troppi stack');

  const total = stacks * STACK_SIZE + extra;
  if (total > MAX_ITEMS) throw new Error('Superato limite item');

  return {
    total,
    stacks,
    extra,
  };
}

function unitToStack(unit) {
  const stacks = Math.floor(unit / STACK_SIZE);
  const extra = unit % STACK_SIZE;
  return { stacks, extra };
}

// --------------------
// KILL
// --------------------
function parseKill(input) {
  if (!input) throw new Error('Kill mancanti');
  if (input.includes(',')) throw new Error('Virgole non ammesse');

  const n = Number(input);
  if (isNaN(n)) throw new Error('Numero non valido');
  if (n > 10_000) throw new Error('Massimo 10.000 kill');

  return n;
}

// --------------------
// TESTO INFO
// --------------------
function parseInfo(text) {
  if (!text) return '';
  if (text.length > 10_000) throw new Error('Testo troppo lungo');
  return text;
}

// --------------------
// CALCOLO GIORNALIERO (LAZY)
// --------------------
function calculateUpdatedAmount(original, days) {
  let value = original;
  for (let i = 0; i < days; i++) {
    value = apply3Percent(value);
  }
  return value;
}

// ================================
// FASE 4B – THREAD & EMBED
// ================================

function formatMoneyDisplay(value) {
  if (value >= MULTIPLIERS.t) return (value / MULTIPLIERS.t).toFixed(3).replace(/\.?0+$/, '') + 'T';
  if (value >= MULTIPLIERS.b) return (value / MULTIPLIERS.b).toFixed(3).replace(/\.?0+$/, '') + 'B';
  if (value >= MULTIPLIERS.m) return (value / MULTIPLIERS.m).toFixed(3).replace(/\.?0+$/, '') + 'M';
  if (value >= MULTIPLIERS.k) return (value / MULTIPLIERS.k).toFixed(3).replace(/\.?0+$/, '') + 'K';
  return value.toString();
}

function formatItemDisplay(units) {
  const rounded = roundForDisplay(units);
  const { stacks, extra } = unitToStack(rounded);

  return {
    unit: `${rounded} unità`,
    stack: `${stacks} stack${extra > 0 ? ` + ${extra}` : ''}`,
  };
}

// --------------------
// EMBED PRESTITO
// --------------------
function buildLoanEmbed(prestito) {
  const now = new Date();
  let giorni = 0;

  if (prestito.data_accettazione) {
    const last = prestito.ultimo_incremento
      ? new Date(prestito.ultimo_incremento)
      : new Date(prestito.data_accettazione);

    giorni = Math.floor((now - last) / (1000 * 60 * 60 * 24));
  }

  let attuale = prestito.importo_attuale;
  if (prestito.stato === 'attivo' && giorni > 0) {
    attuale = calculateUpdatedAmount(attuale, giorni);
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

  // ---- SOLDI
  if (prestito.categoria === 'Soldi') {
    embed.addFields(
      {
        name: '💰 Importo originale',
        value: formatMoneyDisplay(prestito.importo_originale),
        inline: true,
      },
      {
        name: '🔄 Importo attuale',
        value: formatMoneyDisplay(attuale),
        inline: true,
      }
    );
  }

  // ---- ITEM
  if (prestito.categoria === 'Item') {
    const orig = formatItemDisplay(prestito.importo_originale);
    const curr = formatItemDisplay(attuale);

    embed.addFields(
      {
        name: '📦 Importo originale',
        value: `${orig.unit}\n${orig.stack}`,
        inline: true,
      },
      {
        name: '🔄 Importo attuale',
        value: `${curr.unit}\n${curr.stack}`,
        inline: true,
      }
    );
  }

  // ---- KILL
  if (prestito.categoria === 'Kill') {
    embed.addFields(
      {
        name: '☠ Kill originali',
        value: prestito.importo_originale.toString(),
        inline: true,
      },
      {
        name: '🔄 Kill attuali',
        value: roundForDisplay(attuale).toString(),
        inline: true,
      }
    );
  }

  // ---- INFO
  if (prestito.categoria === 'Info') {
    embed.addFields({
      name: 'ℹ Informazioni',
      value: prestito.prove || '—',
    });
  }

  return embed;
}

// --------------------
// THREAD CREATION
// --------------------
async function createLoanThread(channel, prestito) {
  const message = await channel.send({
    content: `📌 Nuovo prestito creato`,
    embeds: [buildLoanEmbed(prestito)],
  });

  const thread = await message.startThread({
    name: `Prestito #${prestito.id}`,
    autoArchiveDuration: 1440,
  });

  db.prepare(`
    UPDATE prestiti
    SET thread_id = ?
    WHERE id = ?
  `).run(thread.id, prestito.id);

  return thread;
}

// ================================
// FASE 4C – MODALI CREAZIONE PRESTITO
// ================================

// --------- UTILS VALIDAZIONE ---------
function normalizeMoneyInput(input) {
  let value = input.toLowerCase().trim();
  value = value.replace(/,/g, ''); // NO virgole
  value = value.replace(/(\d+)k$/, (_, n) => `${n}000`);
  value = value.replace(/(\d+)m$/, (_, n) => `${n}000000`);
  value = value.replace(/(\d+)b$/, (_, n) => `${n}000000000`);
  value = value.replace(/(\d+)t$/, (_, n) => `${n}000000000000`);
  return value;
}

function parseMoneyStrict(input) {
  if (!/^\d+(\.\d+)?[kmbtKMBT]?$/.test(input)) return null;

  const raw = normalizeMoneyInput(input);
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  if (num > 10_000_000_000_000) return null; // 10T
  return num;
}

// --------- MODALI ---------
function buildSoldiModal() {
  return new ModalBuilder()
    .setCustomId('modal_soldi')
    .setTitle('💰 Nuovo prestito – Soldi')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('importo')
          .setLabel('Importo (es: 1.5m, 200k, 1500000)')
          .setStyle(TextInputStyle.Short)
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
}

function buildItemModal() {
  return new ModalBuilder()
    .setCustomId('modal_item')
    .setTitle('📦 Nuovo prestito – Item')
    .addComponents(
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
          .setLabel('Item extra (0–63)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue('0')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('debitore')
          .setLabel('ID o @ del debitore')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
}

// --------- BUTTON HANDLER ---------
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isButton()) {

      // ---- SOLDI
      if (interaction.customId === 'cat_soldi') {
        return interaction.showModal(buildSoldiModal());
      }

      // ---- ITEM
      if (interaction.customId === 'cat_item') {
        return interaction.showModal(buildItemModal());
      }
    }

    // --------- MODAL SUBMIT ---------
    if (interaction.isModalSubmit()) {

      // ===== SOLDI =====
      if (interaction.customId === 'modal_soldi') {
        const input = interaction.fields.getTextInputValue('importo');
        const debitoreRaw = interaction.fields.getTextInputValue('debitore');

        const valore = parseMoneyStrict(input);
        if (!valore) {
          return interaction.reply({
            content: '❌ Importo non valido. Usa numeri + k/m/b/t (max 10T).',
            ephemeral: true,
          });
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

      // ===== ITEM =====
      if (interaction.customId === 'modal_item') {
        const stack = Number(interaction.fields.getTextInputValue('stack'));
        const extra = Number(interaction.fields.getTextInputValue('extra') || 0);
        const debitoreRaw = interaction.fields.getTextInputValue('debitore');

        if (!Number.isInteger(stack) || stack < 0) {
          return interaction.reply({ content: '❌ Stack non validi.', ephemeral: true });
        }
        if (!Number.isInteger(extra) || extra < 0 || extra > 63) {
          return interaction.reply({ content: '❌ Extra item 0–63.', ephemeral: true });
        }

        const totalUnits = stack * 64 + extra;
        if (totalUnits > 10_000_000_000_000) {
          return interaction.reply({ content: '❌ Superato limite massimo.', ephemeral: true });
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
    }
  } catch (err) {
    console.error('FASE 4C error:', err);
  }
});

// ================================
// FASE 4D – ACCETTA / DECLINA PRESTITO
// ================================

// Pulsanti Accetta / Rifiuta
function buildAcceptRow(prestitoId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`prestito_accetta_${prestitoId}`)
      .setLabel('✅ Accetta')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`prestito_rifiuta_${prestitoId}`)
      .setLabel('❌ Rifiuta')
      .setStyle(ButtonStyle.Danger)
  );
}

// Handler
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isButton()) return;

    // ===== ACCETTA =====
    if (interaction.customId.startsWith('prestito_accetta_')) {
      const prestitoId = interaction.customId.split('_')[2];
      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
      if (!prestito) {
        return interaction.reply({ content: '❌ Prestito non trovato.', ephemeral: true });
      }

      if (interaction.user.id !== prestito.debitore_id) {
        return interaction.reply({ content: '❌ Solo il debitore può accettare.', ephemeral: true });
      }

      if (prestito.stato !== 'attesa') {
        return interaction.reply({ content: '⚠️ Prestito già gestito.', ephemeral: true });
      }

      const now = new Date().toISOString();

      db.prepare(`
        UPDATE prestiti
        SET stato = 'attivo',
            data_accettazione = ?,
            ultimo_incremento = ?
        WHERE id = ?
      `).run(now, now, prestitoId);

      await interaction.update({
        content: '✅ Prestito ACCETTATO. Il 3% giornaliero è ora attivo.',
        components: []
      });

      // aggiorna embed nel thread
      const thread = await interaction.channel.fetch().catch(() => null);
      if (thread && thread.isThread()) {
        const messages = await thread.messages.fetch({ limit: 1 }).catch(() => null);
        const firstMsg = messages?.first();
        if (firstMsg) {
          const updated = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
          const embed = creaEmbedPrestito(updated);
          if (embed) {
            await firstMsg.edit({ embeds: [embed], components: [] }).catch(() => null);
          }
        }
      }
      return;
    }

    // ===== RIFIUTA =====
    if (interaction.customId.startsWith('prestito_rifiuta_')) {
      const prestitoId = interaction.customId.split('_')[2];
      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
      if (!prestito) {
        return interaction.reply({ content: '❌ Prestito non trovato.', ephemeral: true });
      }

      if (interaction.user.id !== prestito.debitore_id) {
        return interaction.reply({ content: '❌ Solo il debitore può rifiutare.', ephemeral: true });
      }

      if (prestito.stato !== 'attesa') {
        return interaction.reply({ content: '⚠️ Prestito già gestito.', ephemeral: true });
      }

      db.prepare(`
        UPDATE prestiti
        SET stato = 'declinato'
        WHERE id = ?
      `).run(prestitoId);

      await interaction.update({
        content: '❌ Prestito RIFIUTATO.',
        components: []
      });

      // chiudi thread
      const thread = await interaction.channel.fetch().catch(() => null);
      if (thread && thread.isThread()) {
        await thread.setArchived(true).catch(() => null);
      }
      return;
    }
  } catch (err) {
    console.error('FASE 4D error:', err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Errore interno.', ephemeral: true });
      }
    } catch {}
  }
});

function buildUpdateRow(prestitoId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`prestito_aggiorna_${prestitoId}`)
      .setLabel('🔄 Aggiorna calcoli')
      .setStyle(ButtonStyle.Secondary)
  );
}

function aggiornaPrestito(prestito) {
  if (prestito.stato !== 'attivo') return null;

  const now = new Date();
  const last = new Date(prestito.ultimo_incremento || prestito.data_accettazione);
  const MS_DAY = 24 * 60 * 60 * 1000;

  const giorni = Math.floor((now - last) / MS_DAY);
  if (giorni <= 0) return null;

  let nuovoImporto = prestito.importo_attuale;

  for (let i = 0; i < giorni; i++) {
    nuovoImporto = nuovoImporto * 1.03;
  }

  db.prepare(`
    UPDATE prestiti
    SET importo_attuale = ?, ultimo_incremento = ?
    WHERE id = ?
  `).run(nuovoImporto, now.toISOString(), prestito.id);

  return { giorni, nuovoImporto };
}

client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isButton()) return;

    if (!interaction.customId.startsWith('prestito_aggiorna_')) return;

    const prestitoId = interaction.customId.split('_')[2];
    const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);

    if (!prestito) {
      return interaction.reply({ content: '❌ Prestito non trovato.', ephemeral: true });
    }

    // SOLO mittente o debitore
    if (![prestito.mittente_id, prestito.debitore_id].includes(interaction.user.id)) {
      return interaction.reply({ content: '❌ Non sei autorizzato.', ephemeral: true });
    }

    const risultato = aggiornaPrestito(prestito);

    if (!risultato) {
      return interaction.reply({
        content: '⏳ Nessun aggiornamento disponibile.',
        ephemeral: true
      });
    }

    const aggiornato = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
    const embed = creaEmbedPrestito(aggiornato);

    await interaction.reply({
      content: `🔄 Aggiornato di **${risultato.giorni} giorno/i** (+3% giornaliero).`,
      ephemeral: true
    });

    // aggiorna embed nel thread
    if (aggiornato.thread_id) {
      const thread = await client.channels.fetch(aggiornato.thread_id).catch(() => null);
      if (thread && thread.isThread()) {
        const msgs = await thread.messages.fetch({ limit: 1 }).catch(() => null);
        const first = msgs?.first();
        if (first && embed) {
          await first.edit({
            embeds: [embed],
            components: [buildUpdateRow(prestitoId)]
          }).catch(() => null);
        }
      }
    }
  } catch (err) {
    console.error('FASE 4E error:', err);
  }
});

function buildPaymentRow(prestitoId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`prestito_paga_${prestitoId}`)
      .setLabel('💸 Paga')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`prestito_chiudi_${prestitoId}`)
      .setLabel('🔒 Chiudi prestito')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildPagamentoModal(prestito) {
  const modal = new ModalBuilder()
    .setCustomId(`modal_paga_${prestito.id}`)
    .setTitle('Pagamento prestito');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('importo')
        .setLabel('Importo da pagare')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Es: 500k, 1.2m, 3 stack + 20')
        .setRequired(true)
    )
  );

  return modal;
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('prestito_paga_')) return;

  const prestitoId = interaction.customId.split('_')[2];
  const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
  if (!prestito) return interaction.reply({ content: '❌ Prestito non trovato.', ephemeral: true });

  if (interaction.user.id !== prestito.debitore_id) {
    return interaction.reply({ content: '❌ Solo il debitore può pagare.', ephemeral: true });
  }

  await interaction.showModal(buildPagamentoModal(prestito));
});

function validaPagamento(input, prestito) {
  const valore = parseNumero(input);
  if (!valore || valore <= 0) return { error: 'Importo non valido.' };

  if (valore > prestito.importo_attuale) {
    return { error: '❌ Non puoi pagare più del residuo.' };
  }

  return { valore };
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith('modal_paga_')) return;

  const prestitoId = interaction.customId.split('_')[2];
  const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
  if (!prestito) return interaction.reply({ content: 'Prestito non trovato.', ephemeral: true });

  const input = interaction.fields.getTextInputValue('importo');
  const check = validaPagamento(input, prestito);
  if (check.error) {
    return interaction.reply({ content: check.error, ephemeral: true });
  }

  const valore = check.valore;
  const nuovoResiduo = prestito.importo_attuale - valore;

  db.prepare(`
    INSERT INTO pagamenti (prestito_id, importo, data)
    VALUES (?, ?, ?)
  `).run(prestito.id, valore, new Date().toISOString());

  db.prepare(`
    UPDATE prestiti SET importo_attuale = ? WHERE id = ?
  `).run(nuovoResiduo, prestito.id);

  await interaction.reply({
    content: `💸 Pagamento registrato: **${formattaNumero(valore)}**`,
    ephemeral: true
  });

  // chiusura automatica se zero
  if (nuovoResiduo <= 0.0001) {
    db.prepare(`UPDATE prestiti SET stato = 'completato' WHERE id = ?`).run(prestito.id);
  }
});

async function aggiornaEmbedThread(client, prestitoId) {
  const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
  if (!prestito || !prestito.thread_id) return;

  const thread = await client.channels.fetch(prestito.thread_id).catch(() => null);
  if (!thread) return;

  const msgs = await thread.messages.fetch({ limit: 1 }).catch(() => null);
  const first = msgs?.first();
  if (!first) return;

  await first.edit({
    embeds: [creaEmbedPrestito(prestito)],
    components: [
      buildUpdateRow(prestitoId),
      buildPaymentRow(prestitoId)
    ]
  }).catch(() => null);
}

function buildAcceptDeclineRow(prestitoId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`prestito_accetta_${prestitoId}`)
      .setLabel('✅ Accetta')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`prestito_rifiuta_${prestitoId}`)
      .setLabel('❌ Rifiuta')
      .setStyle(ButtonStyle.Danger)
  );
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('prestito_accetta_')) return;

  const prestitoId = interaction.customId.split('_')[2];
  const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
  if (!prestito) return interaction.reply({ content: 'Prestito non trovato.', ephemeral: true });

  if (interaction.user.id !== prestito.creditore_id) {
    return interaction.reply({ content: '❌ Solo il creditore può accettare.', ephemeral: true });
  }

  if (prestito.stato !== 'in_attesa') {
    return interaction.reply({ content: '⚠ Prestito già gestito.', ephemeral: true });
  }

  const channel = interaction.channel;
  const thread = await channel.threads.create({
    name: `Prestito #${prestito.id}`,
    autoArchiveDuration: 1440,
    reason: 'Prestito accettato'
  });

  db.prepare(`
    UPDATE prestiti
    SET stato = 'attivo', thread_id = ?
    WHERE id = ?
  `).run(thread.id, prestito.id);

  await thread.send({
    embeds: [creaEmbedPrestito(prestito)],
    components: [
      buildUpdateRow(prestito.id),
      buildPaymentRow(prestito.id)
    ]
  });

  await interaction.update({
    content: '✅ Prestito accettato. Thread creato.',
    components: []
  });
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('prestito_rifiuta_')) return;

  const prestitoId = interaction.customId.split('_')[2];
  const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
  if (!prestito) return interaction.reply({ content: 'Prestito non trovato.', ephemeral: true });

  if (interaction.user.id !== prestito.creditore_id) {
    return interaction.reply({ content: '❌ Solo il creditore può rifiutare.', ephemeral: true });
  }

  if (prestito.stato !== 'in_attesa') {
    return interaction.reply({ content: '⚠ Prestito già gestito.', ephemeral: true });
  }

  db.prepare(`UPDATE prestiti SET stato = 'rifiutato' WHERE id = ?`).run(prestito.id);

  await interaction.update({
    content: '❌ Prestito rifiutato.',
    components: []
  });
});

function buildCloseConfirmRow(prestitoId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`prestito_chiudi_confirm_${prestitoId}`)
      .setLabel('⚠ Conferma chiusura')
      .setStyle(ButtonStyle.Danger)
  );
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('prestito_chiudi_')) return;

  const prestitoId = interaction.customId.split('_')[2];
  const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
  if (!prestito) return interaction.reply({ content: 'Prestito non trovato.', ephemeral: true });

  if (![prestito.creditore_id, prestito.debitore_id].includes(interaction.user.id)) {
    return interaction.reply({ content: '❌ Non puoi chiudere questo prestito.', ephemeral: true });
  }

  await interaction.reply({
    content: '⚠ Confermi la chiusura definitiva?',
    components: [buildCloseConfirmRow(prestito.id)],
    ephemeral: true
  });
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('prestito_chiudi_confirm_')) return;

  const prestitoId = interaction.customId.split('_')[3];
  const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
  if (!prestito) return interaction.reply({ content: 'Prestito non trovato.', ephemeral: true });

  db.prepare(`UPDATE prestiti SET stato = 'chiuso' WHERE id = ?`).run(prestito.id);

  if (prestito.thread_id) {
    const thread = await interaction.client.channels.fetch(prestito.thread_id).catch(() => null);
    if (thread) {
      await thread.send('🔒 Prestito chiuso definitivamente.');
      await thread.setLocked(true).catch(() => null);
      await thread.setArchived(true).catch(() => null);
    }
  }

  await interaction.update({
    content: '🔒 Prestito chiuso.',
    components: []
  });
});

function applicaInteressi(prestito) {
  if (prestito.stato !== 'attivo') return false;

  const now = new Date();
  const last = prestito.ultimo_incremento
    ? new Date(prestito.ultimo_incremento)
    : new Date(prestito.data_accettazione);

  const msGiorno = 24 * 60 * 60 * 1000;
  const giorniPassati = Math.floor((now - last) / msGiorno);

  if (giorniPassati <= 0) return false;

  let valoreReale = Number(prestito.valore_reale);

  for (let i = 0; i < giorniPassati; i++) {
    valoreReale += valoreReale * 0.03;
  }

  db.prepare(`
    UPDATE prestiti
    SET valore_reale = ?, ultimo_incremento = ?
    WHERE id = ?
  `).run(valoreReale, now.toISOString(), prestito.id);

  return true;
}

function buildUpdateRow(prestitoId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`prestito_refresh_${prestitoId}`)
      .setLabel('🔄 Aggiorna calcoli')
      .setStyle(ButtonStyle.Secondary)
  );
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('prestito_refresh_')) return;

  const prestitoId = interaction.customId.split('_')[2];
  const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);

  if (!prestito) {
    return interaction.reply({ content: 'Prestito non trovato.', ephemeral: true });
  }

  if (![prestito.creditore_id, prestito.debitore_id].includes(interaction.user.id)) {
    return interaction.reply({ content: '❌ Non sei autorizzato.', ephemeral: true });
  }

  const aggiornato = applicaInteressi(prestito);

  if (!aggiornato) {
    return interaction.reply({
      content: '⏳ Nessun nuovo interesse da applicare.',
      ephemeral: true
    });
  }

  const thread = await interaction.client.channels.fetch(prestito.thread_id).catch(() => null);
  if (!thread) return;

  const messages = await thread.messages.fetch({ limit: 1 });
  const msg = messages.first();

  if (msg) {
    await msg.edit({
      embeds: [creaEmbedPrestito(prestito)],
      components: [
        buildUpdateRow(prestito.id),
        buildPaymentRow(prestito.id),
        buildCloseRow(prestito.id)
      ]
    });
  }

  await interaction.reply({
    content: '🔄 Interessi aggiornati correttamente.',
    ephemeral: true
  });
});

setInterval(() => {
  const prestiti = db.prepare(`
    SELECT * FROM prestiti
    WHERE stato = 'attivo'
  `).all();

  for (const prestito of prestiti) {
    applicaInteressi(prestito);
  }
}, 60 * 60 * 1000); // ogni ora


    // ----------------------------
    // CREA PRESTITO
    // ----------------------------
    if (interaction.isModalSubmit() && interaction.customId.startsWith('crea_')) {
      const categoria = interaction.customId.replace('crea_', '');
      const debitoreId = interaction.fields.getTextInputValue('debitore');
      const importo = Number(interaction.fields.getTextInputValue('importo'));

      if (isNaN(importo) || importo <= 0) {
        return interaction.reply({ content: '❌ Importo non valido', ephemeral: true });
      }

      const debitore = await interaction.guild.members.fetch(debitoreId).catch(() => null);
      if (!debitore) {
        return interaction.reply({ content: '❌ Debitore non trovato', ephemeral: true });
      }

      const stmt = db.prepare(`
        INSERT INTO prestiti (
          guild_id, categoria,
          mittente_id, mittente_nome,
          debitore_id, debitore_nome,
          importo_originale, importo_attuale,
          stato, creato_il
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'attesa', ?)
      `);

      const result = stmt.run(
        interaction.guildId,
        categoria,
        interaction.user.id,
        interaction.user.username,
        debitore.id,
        debitore.user.username,
        importo,
        importo,
        new Date().toISOString()
      );

      const prestitoId = result.lastInsertRowid;

      const thread = await interaction.channel.threads.create({
        name: `prestito-${prestitoId}`,
        autoArchiveDuration: 1440,
      });

      db.prepare('UPDATE prestiti SET thread_id = ? WHERE id = ?').run(thread.id, prestitoId);

      const embed = new EmbedBuilder()
        .setColor('#f1c40f')
        .setTitle(`📄 Prestito #${prestitoId}`)
        .addFields(
          { name: 'Categoria', value: categoria, inline: true },
          { name: 'Mittente', value: interaction.user.username, inline: true },
          { name: 'Debitore', value: debitore.user.username, inline: true },
          { name: 'Importo', value: String(importo), inline: true },
          { name: 'Stato', value: '🟡 In attesa', inline: true },
        );

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`accetta_${prestitoId}`).setLabel('Accetta').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`rifiuta_${prestitoId}`).setLabel('Rifiuta').setStyle(ButtonStyle.Danger),
      );

      await thread.send({ embeds: [embed], components: [buttons] });
      await interaction.reply({ content: '✅ Prestito creato!', ephemeral: true });
      return;
    }

    // ----------------------------
    // ACCETTA / RIFIUTA
    // ----------------------------
    if (interaction.isButton() && /^(accetta|rifiuta)_\d+$/.test(interaction.customId)) {
      const [azione, id] = interaction.customId.split('_');
      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(id);
      if (!prestito) return interaction.reply({ content: 'Prestito non trovato', ephemeral: true });

      if (interaction.user.id !== prestito.debitore_id) {
        return interaction.reply({ content: '❌ Solo il debitore può farlo', ephemeral: true });
      }

      if (azione === 'rifiuta') {
        db.prepare('UPDATE prestiti SET stato = ? WHERE id = ?').run('rifiutato', id);
        await interaction.update({ content: '❌ Prestito rifiutato', components: [] });
        return;
      }

      db.prepare('UPDATE prestiti SET stato = ? WHERE id = ?').run('attivo', id);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`chiudi_${id}`).setLabel('Chiudi prestito').setStyle(ButtonStyle.Secondary)
      );

      await interaction.update({ content: '✅ Prestito accettato', components: [row] });
      return;
    }

    // ----------------------------
    // CHIUDI PRESTITO
    // ----------------------------
    if (interaction.isButton() && interaction.customId.startsWith('chiudi_')) {
      const id = interaction.customId.split('_')[1];
      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(id);

      if (interaction.user.id !== prestito.mittente_id) {
        return interaction.reply({ content: '❌ Solo il mittente può chiudere', ephemeral: true });
      }

      db.prepare('UPDATE prestiti SET stato = ? WHERE id = ?').run('chiuso', id);
      await interaction.update({ content: '🔒 Prestito chiuso', components: [] });
    }
  } catch (err) {
    console.error(err);
    if (!interaction.replied) {
      await interaction.reply({ content: '❌ Errore interno', ephemeral: true }).catch(() => {});
    }
  }
});

// ================================
// EXPRESS (RENDER)
// ================================
const app = express();
app.get('/', (_, res) => res.json({ status: 'online' }));
app.get('/health', (_, res) => res.json({ status: 'healthy' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Express su ${PORT}`));

// ================================
// LOGIN
// ================================
client.login(CONFIG.TOKEN);
