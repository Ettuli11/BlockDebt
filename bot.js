// BlockDebt - Bot Discord per gestione prestiti Minecraft
// Requisiti: npm install discord.js better-sqlite3 express

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
const Database = require('better-sqlite3');

// -------------------- CONFIG --------------------
const CONFIG = {
  TOKEN: process.env.DISCORD_TOKEN,
  PRESTITI_CHANNEL_ID: process.env.CHANNEL_ID || '1456768128880082995',
  HOLIDAYS: [] // Array di date 'YYYY-MM-DD'
};

if (!CONFIG.TOKEN) {
  console.error('❌ DISCORD_TOKEN mancante! Impostalo nelle Environment Variables (Render / .env).');
  process.exit(1);
}

// -------------------- DB (path robusto) --------------------
let dbPath;
if (fs.existsSync('/app/data')) {
  dbPath = '/app/data/blockdebt.db'; // use Render persistent disk if mounted
} else {
  dbPath = path.join(__dirname, 'blockdebt.db');
}
const db = new Database(dbPath);

// create tables if not exists
db.exec(`
CREATE TABLE IF NOT EXISTS prestiti (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mittente_id TEXT NOT NULL,
  mittente_nome TEXT NOT NULL,
  debitore_id TEXT NOT NULL,
  debitore_nome TEXT NOT NULL,
  categoria TEXT NOT NULL,
  importo_originale REAL NOT NULL,
  importo_attuale REAL NOT NULL,
  valore_reale REAL,
  prove TEXT,
  data_creazione TEXT NOT NULL,
  data_accettazione TEXT,
  ultimo_incremento TEXT,
  stato TEXT NOT NULL,
  thread_id TEXT,
  guild_id TEXT NOT NULL
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS pagamenti (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prestito_id INTEGER NOT NULL,
  importo REAL NOT NULL,
  data TEXT NOT NULL,
  confermato INTEGER DEFAULT 0,
  FOREIGN KEY (prestito_id) REFERENCES prestiti(id)
);
`);

// -------------------- UTIL --------------------
function formattaNumero(num) {
  const n = Number(num) || 0;
  const absNum = Math.abs(n);
  if (absNum >= 1e12) return (n / 1e12).toFixed(3).replace(/\.?0+$/, '') + 'T';
  if (absNum >= 1e9)  return (n / 1e9).toFixed(3).replace(/\.?0+$/, '') + 'B';
  if (absNum >= 1e6)  return (n / 1e6).toFixed(3).replace(/\.?0+$/, '') + 'm';
  if (absNum >= 1e3)  return (n / 1e3).toFixed(3).replace(/\.?0+$/, '') + 'k';
  return n.toString();
}

function parseNumero(str) {
  if (str == null) return null;
  str = String(str).toLowerCase().replace(/\s/g, '');
  const multipliers = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  const match = str.match(/^([0-9,.]+)([kmbt]?)$/);
  if (!match) return null;
  const num = parseFloat(match[1].replace(',', '.'));
  const mult = multipliers[match[2]] || 1;
  return num * mult;
}

function arrotondaItem(valoreReale) {
  const v = Number(valoreReale) || 0;
  const decimale = v - Math.floor(v);
  return decimale >= 0.5 ? Math.ceil(v) : Math.floor(v);
}

function isHoliday(date) {
  const dateStr = date.toISOString().split('T')[0];
  return CONFIG.HOLIDAYS.includes(dateStr);
}

// -------------------- LOGICA INCREMENTI --------------------
function calcolaIncrementi(prestito) {
  // Non forzare il DB qui; la funzione deve ricevere l'oggetto prestito
  try {
    if (!prestito || !prestito.data_accettazione || prestito.categoria === 'Info') return null;

    const now = new Date();
    const dataAcc = new Date(prestito.data_accettazione);
    const ultimo = prestito.ultimo_incremento ? new Date(prestito.ultimo_incremento) : dataAcc;

    // se è festa o weekend, non incrementare (esempio)
    if (isHoliday(now)) return null;

    // esempio semplice: incremento giornaliero 3% per 'Soldi' dopo ogni giorno intero:
    const msPerGiorno = 24 * 60 * 60 * 1000;
    let giorni = Math.floor((now - ultimo) / msPerGiorno);
    if (giorni <= 0) return null;

    // calcola incremento
    if (prestito.categoria === 'Soldi') {
      let attuale = Number(prestito.importo_attuale);
      for (let i = 0; i < giorni; i++) {
        attuale = attuale * 1.03; // +3%
      }
      const nowIso = now.toISOString();
      db.prepare('UPDATE prestiti SET importo_attuale = ?, ultimo_incremento = ? WHERE id = ?')
        .run(attuale, nowIso, prestito.id);
      return { nuoviGiorni: giorni, importo_attuale: attuale };
    }
    return null;
  } catch (err) {
    console.error('calcolaIncrementi error:', err);
    return null;
  }
}

// -------------------- CREAZIONE EMBED --------------------
function creaEmbedPrestito(prestito) {
  const prestitoAgg = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestito.id);
  if (!prestitoAgg) return null;

  let importoVisualizzato;
  if (prestitoAgg.categoria === 'Item' || prestitoAgg.categoria === 'Kill') {
    importoVisualizzato = arrotondaItem(prestitoAgg.valore_reale || prestitoAgg.importo_attuale);
  } else {
    importoVisualizzato = prestitoAgg.importo_attuale;
  }

  const emoji = { 'Soldi': '💰', 'Item': '📦', 'Kill': '☠', 'Info': 'ℹ' };
  const stati = { 'attesa': '🟡 IN ATTESA DI ACCETTAZIONE', 'declinato': '❌ DECLINATO', 'attivo': '🟢 ATTIVO', 'completato': '✅ COMPLETATO' };

  const embed = new EmbedBuilder()
    .setColor(prestitoAgg.stato === 'attivo' ? '#00ff00' : prestitoAgg.stato === 'declinato' ? '#ff0000' : '#ffff00')
    .setTitle(`${emoji[prestitoAgg.categoria] || ''} Prestito #${prestitoAgg.id} — ${prestitoAgg.categoria}`)
    .addFields(
      { name: '🟢 Mittente', value: prestitoAgg.mittente_nome || 'N/A', inline: true },
      { name: '🔴 Debitore', value: prestitoAgg.debitore_nome || 'N/A', inline: true },
      { name: '📂 Categoria', value: prestitoAgg.categoria || 'N/A', inline: true },
      { name: '📦 Importo originale', value: prestitoAgg.categoria === 'Soldi' ? formattaNumero(prestitoAgg.importo_originale) : String(prestitoAgg.importo_originale), inline: true },
      { name: '🔄 Importo attuale', value: prestitoAgg.categoria === 'Soldi' ? formattaNumero(importoVisualizzato) : String(importoVisualizzato), inline: true },
      { name: '📅 Data creazione', value: new Date(prestitoAgg.data_creazione).toLocaleDateString('it-IT'), inline: true }
    )
    .setFooter({ text: `Stato: ${stati[prestitoAgg.stato] || prestitoAgg.stato}` })
    .setTimestamp();

  if (prestitoAgg.prove) embed.addFields({ name: '🖼 Prove', value: prestitoAgg.prove });

  return embed;
}

// -------------------- SAFE REPLY / UPDATE --------------------
async function safeReply(interaction, options = {}) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.followUp(options);
    } else {
      return await interaction.reply(options);
    }
  } catch (err) {
    // Interaction expired -> try to send channel message if possible
    try {
      if (interaction.channel) {
        return await interaction.channel.send(options.content || options.embeds || options);
      }
    } catch (e) {
      console.error('safeReply fallback failed:', e);
    }
    console.error('safeReply error:', err);
    return null;
  }
}

async function safeUpdate(interaction, options = {}) {
  try {
    return await interaction.update(options);
  } catch (err) {
    return await safeReply(interaction, options);
  }
}

// -------------------- CLIENT --------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// global client error handling (important to avoid crash)
client.on('error', (err) => {
  console.error('Client error:', err);
});
client.on('warn', (info) => console.warn('Client warn:', info));

// -------------------- READY --------------------
client.once('ready', async () => {
  console.log(`✅ BlockDebt online come ${client.user.tag}`);

  // Send initial "Prestiti" message if channel available
  try {
    const channelId = CONFIG.PRESTITI_CHANNEL_ID;
    let channel = null;
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      console.warn('Impossibile fetchare canale prestiti (controlla permessi / id):', err.message);
      channel = null;
    }

    if (channel && channel.isTextBased && channel.permissionsFor(client.user).has('SendMessages')) {
      const embed = new EmbedBuilder().setColor('#0099ff').setTitle('📄 Prestiti').setDescription('Scegli una categoria per avviare un prestito');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cat_soldi').setLabel('Soldi').setEmoji('💰').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cat_item').setLabel('Item').setEmoji('📦').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cat_kill').setLabel('Kill').setEmoji('☠').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('cat_info').setLabel('Info').setEmoji('ℹ').setStyle(ButtonStyle.Primary)
      );
      try { await channel.send({ embeds: [embed], components: [row] }); } catch (err) { console.warn('Invio messaggio iniziale fallito:', err.message); }
    } else {
      console.warn('Canale prestiti non disponibile o bot non ha permessi di invio.');
    }
  } catch (err) {
    console.error('Errore durante ready:', err);
  }

  // Interval per incrementi (protetto)
  setInterval(async () => {
    try {
      const prestitiAttivi = db.prepare('SELECT * FROM prestiti WHERE stato = ?').all('attivo');
      for (const prestito of prestitiAttivi) {
        try {
          const res = calcolaIncrementi(prestito);
          if (res) {
            // aggiorna messaggio nel thread se possibile
            if (prestito.thread_id) {
              try {
                const thread = await client.channels.fetch(prestito.thread_id).catch(()=>null);
                if (thread && thread.isThread()) {
                  const messages = await thread.messages.fetch({ limit: 1 }).catch(()=>null);
                  const firstMsg = messages ? messages.first() : null;
                  if (firstMsg && firstMsg.author && firstMsg.author.id === client.user.id) {
                    const embed = creaEmbedPrestito(prestito);
                    if (embed) await firstMsg.edit({ embeds: [embed] }).catch(()=>null);
                  }
                }
              } catch (err) {
                console.warn('Errore aggiornamento thread:', err.message);
              }
            }
          }
        } catch (err) { console.warn('Errore per prestito:', prestito.id, err); }
      }
    } catch (err) {
      console.error('Interval incrementi error:', err);
    }
  }, 60 * 60 * 1000); // ogni ora
});

// -------------------- INTERACTIONS --------------------
client.on('interactionCreate', async (interaction) => {
  try {
    // only handle buttons
    if (!interaction.isButton()) return;

    // CATEGORIE
    if (interaction.customId.startsWith('cat_')) {
      const categoria = interaction.customId.replace('cat_', '');
      // apri modal o crea thread a seconda della logica...
      await safeReply(interaction, { content: `Hai scelto: ${categoria}`, ephemeral: true });
      return;
    }

    // ESEMPI: conferma/rifiuta completamento
    if (interaction.customId.startsWith('conferma_completa_')) {
      const id = interaction.customId.split('_')[2];
      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(id);
      if (!prestito) return safeReply(interaction, { content: 'Prestito non trovato.', ephemeral: true });
      if (interaction.user.id !== prestito.mittente_id) return safeReply(interaction, { content: '❌ Solo mittente!', ephemeral: true });

      db.prepare('UPDATE prestiti SET stato = ?, importo_attuale = 0 WHERE id = ?').run('completato', id);
      await safeUpdate(interaction, { content: '✅ Completato! 🎉', components: [] });

      try {
        if (prestito.thread_id) {
          const thread = await client.channels.fetch(prestito.thread_id).catch(()=>null);
          if (thread) {
            const messages = await thread.messages.fetch({ limit: 1 }).catch(()=>null);
            const firstMsg = messages ? messages.first() : null;
            if (firstMsg) {
              const embed = creaEmbedPrestito(prestito);
              if (embed) await firstMsg.edit({ embeds: [embed], components: [] }).catch(()=>null);
            }
            await thread.setArchived(true).catch(()=>null);
          }
        }
      } catch (err) { /* swallow */ }
      return;
    }

    if (interaction.customId.startsWith('rifiuta_completa_')) {
      const id = interaction.customId.split('_')[2];
      const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(id);
      if (!prestito) return safeReply(interaction, { content: 'Prestito non trovato.', ephemeral: true });
      if (interaction.user.id !== prestito.mittente_id) return safeReply(interaction, { content: '❌ Solo mittente!', ephemeral: true });
      await safeUpdate(interaction, { content: '❌ Rifiutato.', components: [] });
      return;
    }
  } catch (error) {
    console.error('Errore interactionCreate:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Errore!', ephemeral: true }).catch(()=>null);
      } else {
        await interaction.followUp({ content: '❌ Errore!', ephemeral: true }).catch(()=>null);
      }
    } catch (e) { /* swallow */ }
  }
});

// -------------------- EXPRESS (health + keepalive) --------------------
const app = express();
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: client && client.ws ? 'connected' : 'connecting',
    username: client.user ? client.user.tag : null,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});
app.get('/health', (req, res) => res.json({ status: 'healthy', bot: client && client.readyAt ? 'connected' : 'connecting' }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
});

// -------------------- PROCESS events --------------------
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // per ora non riavviamo automaticamente, pudoi decidere
});

// graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM ricevuto, chiusura...');
  try { server.close(() => { client.destroy(); db.close(); process.exit(0); }); } catch (e) { process.exit(0); }
});

// -------------------- LANCIO BOT --------------------
client.login(CONFIG.TOKEN).catch(error => {
  console.error('❌ Login fallito:', error);
  process.exit(1);
});
