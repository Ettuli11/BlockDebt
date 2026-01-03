// BlockDebt - Bot Discord per gestione prestiti Minecraft
// Production-ready con PostgreSQL (Neon) e deployment su Render

const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType } = require('discord.js');
const { Pool } = require('pg');

// ==================== EXPRESS SERVER (per Render) ====================
const app = express();
const PORT = process.env.PORT || 3000;

let botReady = false;
let botUser = null;

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        bot: botReady ? 'connected' : 'connecting',
        username: botUser ? botUser.tag : 'N/A',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    if (botReady) {
        res.status(200).json({ 
            status: 'healthy', 
            bot: botUser.tag,
            database: pool ? 'connected' : 'disconnected'
        });
    } else {
        res.status(503).json({ status: 'starting' });
    }
});

const server = app.listen(PORT, () => {
    console.log(`🌐 Server HTTP attivo su porta ${PORT}`);
});

// ==================== DATABASE POSTGRESQL (NEON) ====================
if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL mancante! Configura su Render.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

// Test connessione database
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Errore connessione DB:', err.stack);
        process.exit(1);
    }
    console.log('✅ Database PostgreSQL connesso');
    release();
});

// Helper query con gestione errori
async function query(sql, params = []) {
    try {
        const result = await pool.query(sql, params);
        return result;
    } catch (error) {
        console.error('Errore query DB:', error.message);
        console.error('SQL:', sql);
        console.error('Params:', params);
        throw error;
    }
}

// ==================== CONFIGURAZIONE ====================
const CONFIG = {
    TOKEN: process.env.DISCORD_TOKEN,
    PRESTITI_CHANNEL_ID: process.env.CHANNEL_ID,
    HOLIDAYS: [] // Formato: ['2026-12-25', '2026-01-01']
};

if (!CONFIG.TOKEN) {
    console.error('❌ DISCORD_TOKEN mancante! Configura su Render.');
    process.exit(1);
}

if (!CONFIG.PRESTITI_CHANNEL_ID) {
    console.error('⚠️ CHANNEL_ID non configurato, usando default test');
}

// ==================== UTILITÀ ====================
function formattaNumero(num) {
    const absNum = Math.abs(num);
    if (absNum >= 1e12) return (num / 1e12).toFixed(3).replace(/\.?0+$/, '') + 'T';
    if (absNum >= 1e9) return (num / 1e9).toFixed(3).replace(/\.?0+$/, '') + 'B';
    if (absNum >= 1e6) return (num / 1e6).toFixed(3).replace(/\.?0+$/, '') + 'm';
    if (absNum >= 1e3) return (num / 1e3).toFixed(3).replace(/\.?0+$/, '') + 'k';
    return num.toFixed(2).replace(/\.?0+$/, '');
}

function parseNumero(str) {
    str = str.toLowerCase().replace(/\s/g, '').replace(/,/g, '.');
    const multipliers = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
    const match = str.match(/^([0-9.]+)([kmbt]?)$/);
    if (!match) return null;
    const num = parseFloat(match[1]);
    if (isNaN(num)) return null;
    const mult = multipliers[match[2]] || 1;
    return num * mult;
}

function arrotondaItem(valoreReale) {
    const decimale = valoreReale - Math.floor(valoreReale);
    return decimale >= 0.5 ? Math.ceil(valoreReale) : Math.floor(valoreReale);
}

function isHoliday(date) {
    const dateStr = date.toISOString().split('T')[0];
    return CONFIG.HOLIDAYS.includes(dateStr);
}

async function calcolaIncrementi(prestito) {
    if (!prestito.data_accettazione || prestito.categoria === 'Info') return;
    
    const now = new Date();
    const dataAccettazione = new Date(prestito.data_accettazione);
    const ultimoIncremento = prestito.ultimo_incremento ? new Date(prestito.ultimo_incremento) : dataAccettazione;
    
    let giorniPassati = 0;
    let currentDate = new Date(ultimoIncremento);
    currentDate.setDate(currentDate.getDate() + 1);
    currentDate.setHours(0, 0, 0, 0);
    
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    
    while (currentDate <= today) {
        if (!isHoliday(currentDate)) {
            giorniPassati++;
        }
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    if (giorniPassati > 0) {
        if (prestito.categoria === 'Soldi') {
            const nuovoImporto = parseFloat(prestito.importo_attuale) * Math.pow(1.03, giorniPassati);
            await query(
                'UPDATE prestiti SET importo_attuale = $1, ultimo_incremento = $2 WHERE id = $3',
                [nuovoImporto, now.toISOString(), prestito.id]
            );
        } else if (prestito.categoria === 'Item' || prestito.categoria === 'Kill') {
            const valoreReale = parseFloat(prestito.valore_reale || prestito.importo_originale) + 
                               (parseFloat(prestito.importo_originale) * 0.03 * giorniPassati);
            await query(
                'UPDATE prestiti SET valore_reale = $1, ultimo_incremento = $2 WHERE id = $3',
                [valoreReale, now.toISOString(), prestito.id]
            );
        }
    }
}

async function safeReply(interaction, options) {
    try {
        // Controlla se interaction è ancora valida
        if (!interaction || !interaction.isRepliable) {
            console.warn('Interaction non più valida');
            return null;
        }

        if (interaction.replied || interaction.deferred) {
            return await interaction.followUp(options);
        }
        return await interaction.reply(options);
    } catch (error) {
        console.error('Errore safeReply:', error.message);
        // Tentativo DM fallback se possibile
        if (error.code === 10062 || error.code === 40060) {
            console.log('Interaction scaduta, impossibile rispondere');
        }
        return null;
    }
}

async function safeUpdate(interaction, options) {
    try {
        if (!interaction || !interaction.isRepliable) {
            console.warn('Interaction non più valida per update');
            return null;
        }
        return await interaction.update(options);
    } catch (error) {
        console.error('Errore safeUpdate:', error.message);
        // Fallback a reply se update fallisce
        return await safeReply(interaction, { ...options, ephemeral: true });
    }
}

// ==================== EMBED ====================
async function creaEmbedPrestito(prestito, guild) {
    await calcolaIncrementi(prestito);
    const result = await query('SELECT * FROM prestiti WHERE id = $1', [prestito.id]);
    const prestitoAggiornato = result.rows[0];
    
    let importoVisualizzato;
    if (prestitoAggiornato.categoria === 'Item' || prestitoAggiornato.categoria === 'Kill') {
        importoVisualizzato = arrotondaItem(parseFloat(prestitoAggiornato.valore_reale || prestitoAggiornato.importo_attuale));
    } else {
        importoVisualizzato = parseFloat(prestitoAggiornato.importo_attuale);
    }
    
    const emoji = { 'Soldi': '💰', 'Item': '📦', 'Kill': '☠', 'Info': 'ℹ' };
    const stati = {
        'attesa': '🟡 IN ATTESA DI ACCETTAZIONE',
        'declinato': '❌ DECLINATO',
        'attivo': '🟢 ATTIVO',
        'completato': '✅ COMPLETATO'
    };
    
    const importoOriginaleStr = prestitoAggiornato.categoria === 'Soldi' 
        ? formattaNumero(parseFloat(prestitoAggiornato.importo_originale))
        : Math.floor(parseFloat(prestitoAggiornato.importo_originale)).toString();
    
    const importoAttualeStr = prestitoAggiornato.categoria === 'Soldi'
        ? formattaNumero(importoVisualizzato)
        : importoVisualizzato.toString();
    
    const embed = new EmbedBuilder()
        .setColor(
            prestitoAggiornato.stato === 'attivo' ? '#00ff00' : 
            prestitoAggiornato.stato === 'declinato' ? '#ff0000' : 
            prestitoAggiornato.stato === 'completato' ? '#00ffff' : '#ffff00'
        )
        .setTitle(`${emoji[prestitoAggiornato.categoria]} Prestito #${prestitoAggiornato.id} – ${prestitoAggiornato.categoria}`)
        .addFields(
            { name: '🟢 Mittente', value: prestitoAggiornato.mittente_nome, inline: true },
            { name: '🔴 Debitore', value: prestitoAggiornato.debitore_nome, inline: true },
            { name: '📂 Categoria', value: prestitoAggiornato.categoria, inline: true },
            { name: '📦 Importo originale', value: importoOriginaleStr, inline: true },
            { name: '🔄 Importo attuale', value: importoAttualeStr, inline: true },
            { name: '📅 Data creazione', value: new Date(prestitoAggiornato.data_creazione).toLocaleDateString('it-IT'), inline: true }
        )
        .setFooter({ text: `Stato: ${stati[prestitoAggiornato.stato]}` })
        .setTimestamp();
    
    if (prestitoAggiornato.prove) {
        embed.addFields({ name: '🖼 Prove', value: prestitoAggiornato.prove });
    }
    
    return embed;
}

// ==================== BOT DISCORD ====================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ]
});

client.once('ready', async () => {
    botReady = true;
    botUser = client.user;
    console.log(`✅ ${client.user.tag} online`);
    console.log(`📊 ${client.guilds.cache.size} server connessi`);
    
    if (!CONFIG.PRESTITI_CHANNEL_ID) {
        console.warn('⚠️ CHANNEL_ID non configurato');
        return;
    }
    
    try {
        const channel = await client.channels.fetch(CONFIG.PRESTITI_CHANNEL_ID).catch(() => null);
        if (!channel) {
            console.error('❌ Canale non trovato. Verifica CHANNEL_ID.');
            return;
        }
        
        console.log(`✅ Canale: #${channel.name}`);
        
        const messages = await channel.messages.fetch({ limit: 10 }).catch(() => new Map());
        const hasInit = Array.from(messages.values()).some(m => 
            m.author.id === client.user.id && 
            m.embeds[0]?.title === '📄 Prestiti'
        );
        
        if (!hasInit) {
            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('📄 Prestiti')
                .setDescription('Scegli una categoria per avviare un prestito:')
                .addFields(
                    { name: '💰 Soldi', value: 'Prestiti in moneta (con +3% giornaliero)', inline: true },
                    { name: '📦 Item', value: 'Prestiti di oggetti/materiali', inline: true },
                    { name: '☠ Kill', value: 'Debiti da eliminazioni/uccisioni', inline: true },
                    { name: 'ℹ Info', value: 'Note informative (nessun interesse)', inline: true }
                );
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('cat_soldi').setLabel('Soldi').setEmoji('💰').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('cat_item').setLabel('Item').setEmoji('📦').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('cat_kill').setLabel('Kill').setEmoji('☠').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('cat_info').setLabel('Info').setEmoji('ℹ').setStyle(ButtonStyle.Secondary)
            );
            
            await channel.send({ embeds: [embed], components: [row] });
            console.log('✅ Messaggio iniziale inviato');
        }
    } catch (error) {
        console.error('❌ Errore setup canale:', error.message);
    }
    
    // Timer incremento giornaliero (ogni ora verifica)
    setInterval(async () => {
        try {
            const result = await query('SELECT * FROM prestiti WHERE stato = $1', ['attivo']);
            const prestitiAttivi = result.rows;
            
            for (const prestito of prestitiAttivi) {
                await calcolaIncrementi(prestito);
                
                try {
                    const thread = await client.channels.fetch(prestito.thread_id).catch(() => null);
                    if (thread && thread.isThread()) {
                        const messages = await thread.messages.fetch({ limit: 1 }).catch(() => new Map());
                        const firstMsg = messages.first();
                        
                        if (firstMsg?.author.id === client.user.id) {
                            const resultAggiornato = await query('SELECT * FROM prestiti WHERE id = $1', [prestito.id]);
                            const prestitoAggiornato = resultAggiornato.rows[0];
                            const embed = await creaEmbedPrestito(prestitoAggiornato, thread.guild);
                            await firstMsg.edit({ embeds: [embed] }).catch(() => {});
                        }
                    }
                } catch (err) {
                    console.error(`Errore aggiornamento thread ${prestito.id}:`, err.message);
                }
            }
        } catch (error) {
            console.error('Errore timer incremento:', error.message);
        }
    }, 3600000); // Ogni ora
});

client.on('interactionCreate', async interaction => {
    try {
        // ==================== PULSANTI CATEGORIA ====================
        if (interaction.isButton() && interaction.customId.startsWith('cat_')) {
            const categoria = interaction.customId.replace('cat_', '');
            const categoriaNome = categoria.charAt(0).toUpperCase() + categoria.slice(1);
            
            const modal = new ModalBuilder()
                .setCustomId(`modal_${categoria}`)
                .setTitle(`Crea Prestito - ${categoriaNome}`);
            
            const labelImporto = 
                categoria === 'item' ? 'Item (es: Diamanti x64)' :
                categoria === 'kill' ? 'Numero Kill' :
                categoria === 'info' ? 'Informazioni' :
                'Importo (es: 1.5m, 500k, 1000)';
            
            const styleImporto = categoria === 'info' ? TextInputStyle.Paragraph : TextInputStyle.Short;
            
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('mittente')
                        .setLabel('Mittente (chi presta)')
                        .setStyle(TextInputStyle.Short)
                        .setValue(interaction.member?.displayName || interaction.user.username)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('debitore')
                        .setLabel('Debitore (chi deve pagare)')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('Username Discord del debitore')
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('importo')
                        .setLabel(labelImporto)
                        .setStyle(styleImporto)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('prove')
                        .setLabel('Prove (link/immagine - facoltativo)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('data')
                        .setLabel('Data (lascia vuoto per oggi)')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder(new Date().toLocaleDateString('it-IT'))
                        .setRequired(false)
                )
            );
            
            await interaction.showModal(modal);
        }
        
        // ==================== SUBMIT MODALE CREAZIONE ====================
        if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_')) {
            await interaction.deferReply({ ephemeral: true });
            
            const categoria = interaction.customId.replace('modal_', '');
            const categoriaNome = categoria.charAt(0).toUpperCase() + categoria.slice(1);
            
            const mittente = interaction.fields.getTextInputValue('mittente').trim();
            const debitoreInput = interaction.fields.getTextInputValue('debitore').trim();
            const importoRaw = interaction.fields.getTextInputValue('importo').trim();
            const prove = interaction.fields.getTextInputValue('prove').trim() || null;
            const dataInput = interaction.fields.getTextInputValue('data').trim();
            
            const dataCreazione = dataInput ? new Date(dataInput).toISOString() : new Date().toISOString();
            
            // Parsing importo
            let importoNum;
            if (categoria === 'soldi') {
                importoNum = parseNumero(importoRaw);
                if (!importoNum || importoNum <= 0) {
                    return interaction.editReply({ content: '❌ Importo non valido! Usa formato: 1000, 1.5m, 500k' });
                }
            } else if (categoria === 'kill') {
                importoNum = parseInt(importoRaw);
                if (isNaN(importoNum) || importoNum <= 0) {
                    return interaction.editReply({ content: '❌ Numero kill non valido!' });
                }
            } else if (categoria === 'item') {
                // Per item, estrai il numero se presente (es: "Diamanti x64" -> 64)
                const match = importoRaw.match(/\d+/);
                importoNum = match ? parseInt(match[0]) : 1;
            } else {
                importoNum = 0; // Info non ha importo numerico
            }
            
            // Cerca debitore nel server
            const members = await interaction.guild.members.fetch({ query: debitoreInput, limit: 5 }).catch(() => new Map());
            let debitoreId = null;
            let debitoreNome = debitoreInput;
            
            if (members.size > 0) {
                const member = members.first();
                debitoreId = member.id;
                debitoreNome = member.displayName || member.user.username;
            } else {
                // Prova con mention
                const mentionMatch = debitoreInput.match(/<@!?(\d+)>/);
                if (mentionMatch) {
                    debitoreId = mentionMatch[1];
                    try {
                        const user = await client.users.fetch(debitoreId);
                        debitoreNome = user.username;
                    } catch {}
                }
            }
            
            if (!debitoreId) {
                console.warn(`Debitore "${debitoreInput}" non trovato, salvato come sconosciuto`);
            }
            
            // Inserisci prestito nel DB
            const result = await query(`
                INSERT INTO prestiti (
                    mittente_id, mittente_nome, debitore_id, debitore_nome, categoria,
                    importo_originale, importo_attuale, valore_reale, prove, data_creazione,
                    stato, thread_id, guild_id
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                RETURNING id
            `, [
                interaction.user.id,
                mittente,
                debitoreId || 'unknown',
                debitoreNome,
                categoriaNome,
                importoNum,
                importoNum,
                importoNum, // valore_reale iniziale
                prove,
                dataCreazione,
                'attesa',
                'temp',
                interaction.guild.id
            ]);
            
            const prestitoId = result.rows[0].id;
            
            // Crea thread
            const threadName = `prestito-${prestitoId}-${debitoreNome.substring(0, 20)}-${categoria}`;
            const thread = await interaction.channel.threads.create({
                name: threadName,
                type: ChannelType.PrivateThread,
                reason: `Prestito #${prestitoId} - ${categoriaNome}`
            });
            
            // Aggiorna thread_id
            await query('UPDATE prestiti SET thread_id = $1 WHERE id = $2', [thread.id, prestitoId]);
            
            // Recupera prestito e crea embed
            const prestitoResult = await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId]);
            const prestito = prestitoResult.rows[0];
            const embed = await creaEmbedPrestito(prestito, interaction.guild);
            
            // Pulsanti accettazione/declino
            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`accetta_${prestitoId}`)
                    .setLabel('Accetta')
                    .setEmoji('✅')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`declina_${prestitoId}`)
                    .setLabel('Declina')
                    .setEmoji('❌')
                    .setStyle(ButtonStyle.Danger)
            );
            
            // Pulsante chiusura (solo mittente)
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`chiudi_${prestitoId}`)
                    .setLabel('Chiudi prestito')
                    .setEmoji('🔒')
                    .setStyle(ButtonStyle.Secondary)
            );
            
            await thread.send({ 
                content: debitoreId ? `<@${debitoreId}> hai un nuovo prestito da accettare!` : `@${debitoreNome} hai un nuovo prestito!`,
                embeds: [embed], 
                components: [row1, row2] 
            });
            
            // Aggiungi membri al thread
            if (debitoreId) {
                await thread.members.add(debitoreId).catch(() => console.warn('Impossibile aggiungere debitore al thread'));
            }
            await thread.members.add(interaction.user.id).catch(() => {});
            
            await interaction.editReply({ content: `✅ Prestito #${prestitoId} creato! Vai a ${thread}` });
        }
        
        // ==================== ACCETTA PRESTITO ====================
        if (interaction.isButton() && interaction.customId.startsWith('accetta_')) {
            await interaction.deferReply({ ephemeral: true });
            
            const prestitoId = interaction.customId.split('_')[1];
            const result = await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId]);
            const prestito = result.rows[0];
            
            if (!prestito) {
                return interaction.editReply({ content: '❌ Prestito non trovato!' });
            }
            
            if (prestito.debitore_id !== 'unknown' && interaction.user.id !== prestito.debitore_id) {
                return interaction.editReply({ content: '❌ Solo il debitore può accettare!' });
            }
            
            if (prestito.stato !== 'attesa') {
                return interaction.editReply({ content: '❌ Prestito già gestito!' });
            }
            
            // Accetta prestito
            const now = new Date().toISOString();
            await query(
                'UPDATE prestiti SET stato = $1, data_accettazione = $2, ultimo_incremento = $3 WHERE id = $4',
                ['attivo', now, now, prestitoId]
            );
            
            const prestitoAggiornato = (await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId])).rows[0];
            const embed = await creaEmbedPrestito(prestitoAggiornato, interaction.guild);
            
            // Pulsanti gestione attiva (solo per categorie con importo)
            const components = [];
            if (prestito.categoria !== 'Info') {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`paga_${prestitoId}`)
                        .setLabel('Paga parzialmente')
                        .setEmoji('💸')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(`completa_${prestitoId}`)
                        .setLabel('Segna come pagato')
                        .setEmoji('✅')
                        .setStyle(ButtonStyle.Success)
                );
                components.push(row);
            }
            
            // Aggiorna messaggio originale
            try {
                const thread = await client.channels.fetch(prestito.thread_id);
                const messages = await thread.messages.fetch({ limit: 10 });
                const firstMsg = Array.from(messages.values()).find(m => 
                    m.author.id === client.user.id && m.embeds.length > 0
                );
                
                if (firstMsg) {
                    await firstMsg.edit({ embeds: [embed], components });
                }
            } catch (err) {
                console.error('Errore aggiornamento messaggio:', err.message);
            }
            
            await interaction.editReply({ content: '✅ Prestito accettato! Inizia il conteggio +3% giornaliero.' });
        }
        
        // ==================== DECLINA PRESTITO ====================
        if (interaction.isButton() && interaction.customId.startsWith('declina_')) {
            await interaction.deferReply({ ephemeral: true });
            
            const prestitoId = interaction.customId.split('_')[1];
            const result = await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId]);
            const prestito = result.rows[0];
            
            if (!prestito) {
                return interaction.editReply({ content: '❌ Prestito non trovato!' });
            }
            
            if (prestito.debitore_id !== 'unknown' && interaction.user.id !== prestito.debitore_id) {
                return interaction.editReply({ content: '❌ Solo il debitore può declinare!' });
            }
            
            if (prestito.stato !== 'attesa') {
                return interaction.editReply({ content: '❌ Prestito già gestito!' });
            }
            
            await query('UPDATE prestiti SET stato = $1 WHERE id = $2', ['declinato', prestitoId]);
            
            const prestitoAggiornato = (await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId])).rows[0];
            const embed = await creaEmbedPrestito(prestitoAggiornato, interaction.guild);
            
            // Aggiorna messaggio
            try {
                const thread = await client.channels.fetch(prestito.thread_id);
                const messages = await thread.messages.fetch({ limit: 10 });
                const firstMsg = Array.from(messages.values()).find(m => 
                    m.author.id === client.user.id && m.embeds.length > 0
                );
                
                if (firstMsg) {
                    await firstMsg.edit({ embeds: [embed], components: [] });
                }
                
                // Notifica mittente
                try {
                    const mittente = await client.users.fetch(prestito.mittente_id);
                    await mittente.send(`⚠️ Il prestito #${prestitoId} è stato declinato da ${interaction.user.tag}`);
                } catch {}
                
                // Archivia thread
                await thread.setArchived(true);
            } catch (err) {
                console.error('Errore gestione declino:', err.message);
            }
            
            await interaction.editReply({ content: '❌ Prestito declinato.' });
        }
        
        // ==================== PAGA PARZIALMENTE ====================
        if (interaction.isButton() && interaction.customId.startsWith('paga_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const result = await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId]);
            const prestito = result.rows[0];
            
            if (!prestito) {
                return safeReply(interaction, { content: '❌ Prestito non trovato!', ephemeral: true });
            }
            
            if (prestito.debitore_id !== 'unknown' && interaction.user.id !== prestito.debitore_id) {
                return safeReply(interaction, { content: '❌ Solo il debitore può pagare!', ephemeral: true });
            }
            
            if (prestito.stato !== 'attivo') {
                return safeReply(interaction, { content: '❌ Prestito non attivo!', ephemeral: true });
            }
            
            const modal = new ModalBuilder()
                .setCustomId(`paga_modal_${prestitoId}`)
                .setTitle('Pagamento Parziale');
            
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('importo')
                        .setLabel('Importo da pagare')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder(prestito.categoria === 'Soldi' ? 'es: 500k, 1.2m' : 'es: 10')
                        .setRequired(true)
                )
            );
            
            await interaction.showModal(modal);
        }
        
        // ==================== SUBMIT MODALE PAGAMENTO ====================
        if (interaction.isModalSubmit() && interaction.customId.startsWith('paga_modal_')) {
            await interaction.deferReply();
            
            const prestitoId = interaction.customId.split('_')[2];
            const result = await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId]);
            const prestito = result.rows[0];
            
            await calcolaIncrementi(prestito);
            const prestitoAggiornato = (await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId])).rows[0];
            
            const importoRaw = interaction.fields.getTextInputValue('importo').trim();
            let importo;
            
            if (prestito.categoria === 'Soldi') {
                importo = parseNumero(importoRaw);
            } else {
                importo = parseInt(importoRaw);
            }
            
            if (!importo || importo <= 0) {
                return interaction.editReply({ content: '❌ Importo non valido!' });
            }
            
            // Calcola importo attuale visualizzato
            let importoAttuale;
            if (prestitoAggiornato.categoria === 'Item' || prestitoAggiornato.categoria === 'Kill') {
                importoAttuale = arrotondaItem(parseFloat(prestitoAggiornato.valore_reale || prestitoAggiornato.importo_attuale));
            } else {
                importoAttuale = parseFloat(prestitoAggiornato.importo_attuale);
            }
            
            if (importo > importoAttuale) {
                const maxFormatted = prestitoAggiornato.categoria === 'Soldi' 
                    ? formattaNumero(importoAttuale)
                    : importoAttuale.toString();
                return interaction.editReply({ content: `❌ Puoi pagare al massimo: ${maxFormatted}` });
            }
            
            // Registra pagamento in attesa
            await query(
                'INSERT INTO pagamenti (prestito_id, importo, data, confermato) VALUES ($1, $2, $3, $4)',
                [prestitoId, importo, new Date().toISOString(), 0]
            );
            
            // Richiedi conferma mittente
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`conferma_paga_${prestitoId}_${importo}`)
                    .setLabel('Conferma')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`rifiuta_paga_${prestitoId}`)
                    .setLabel('Rifiuta')
                    .setStyle(ButtonStyle.Danger)
            );
            
            const importoFormatted = prestito.categoria === 'Soldi' 
                ? formattaNumero(importo)
                : importo.toString();
            
            await interaction.editReply({ 
                content: `💸 Pagamento di **${importoFormatted}** effettuato da ${interaction.user}.\n<@${prestito.mittente_id}> confermi di aver ricevuto il pagamento?`,
                components: [row]
            });
        }
        
        // ==================== CONFERMA PAGAMENTO ====================
        if (interaction.isButton() && interaction.customId.startsWith('conferma_paga_')) {
            await interaction.deferUpdate();
            
            const parts = interaction.customId.split('_');
            const prestitoId = parts[2];
            const importo = parseFloat(parts[3]);
            
            const result = await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId]);
            const prestito = result.rows[0];
            
            if (interaction.user.id !== prestito.mittente_id) {
                return safeReply(interaction, { content: '❌ Solo il mittente può confermare!', ephemeral: true });
            }
            
            await calcolaIncrementi(prestito);
            const prestitoAggiornato = (await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId])).rows[0];
            
            // Calcola nuovo importo
            let nuovoImporto;
            if (prestitoAggiornato.categoria === 'Soldi') {
                nuovoImporto = parseFloat(prestitoAggiornato.importo_attuale) - importo;
            } else {
                const nuovoValoreReale = parseFloat(prestitoAggiornato.valore_reale || prestitoAggiornato.importo_attuale) - importo;
                await query('UPDATE prestiti SET valore_reale = $1 WHERE id = $2', [nuovoValoreReale, prestitoId]);
                nuovoImporto = nuovoValoreReale;
            }
            
            // Controlla se completato
            if (nuovoImporto <= 0.01) {
                await query(
                    'UPDATE prestiti SET stato = $1, importo_attuale = $2 WHERE id = $3',
                    ['completato', 0, prestitoId]
                );
                
                await interaction.editReply({ 
                    content: '✅ **Prestito completato!** 🎉 Tutti i pagamenti sono stati saldati.', 
                    components: [] 
                });
                
                // Aggiorna embed e archivia
                try {
                    const thread = await client.channels.fetch(prestito.thread_id);
                    const messages = await thread.messages.fetch({ limit: 10 });
                    const firstMsg = Array.from(messages.values()).find(m => 
                        m.author.id === client.user.id && m.embeds.length > 0
                    );
                    
                    if (firstMsg) {
                        const embed = await creaEmbedPrestito(prestitoAggiornato, interaction.guild);
                        await firstMsg.edit({ embeds: [embed], components: [] });
                    }
                    
                    await thread.setArchived(true);
                } catch (err) {
                    console.error('Errore archiviazione:', err.message);
                }
            } else {
                // Aggiorna saldo
                if (prestitoAggiornato.categoria === 'Soldi') {
                    await query('UPDATE prestiti SET importo_attuale = $1 WHERE id = $2', [nuovoImporto, prestitoId]);
                }
                
                const nuovoSaldo = prestitoAggiornato.categoria === 'Soldi'
                    ? formattaNumero(nuovoImporto)
                    : Math.floor(nuovoImporto).toString();
                
                await interaction.editReply({ 
                    content: `✅ Pagamento confermato! Nuovo saldo: **${nuovoSaldo}**`, 
                    components: [] 
                });
                
                // Aggiorna embed
                try {
                    const thread = await client.channels.fetch(prestito.thread_id);
                    const messages = await thread.messages.fetch({ limit: 10 });
                    const firstMsg = Array.from(messages.values()).find(m => 
                        m.author.id === client.user.id && m.embeds.length > 0
                    );
                    
                    if (firstMsg) {
                        const resultFinal = await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId]);
                        const embed = await creaEmbedPrestito(resultFinal.rows[0], interaction.guild);
                        await firstMsg.edit({ embeds: [embed] });
                    }
                } catch (err) {
                    console.error('Errore aggiornamento embed:', err.message);
                }
            }
            
            // Conferma pagamento nel DB
            await query(
                'UPDATE pagamenti SET confermato = 1 WHERE prestito_id = $1 AND importo = $2 AND confermato = 0',
                [prestitoId, importo]
            );
        }
        
        // ==================== RIFIUTA PAGAMENTO ====================
        if (interaction.isButton() && interaction.customId.startsWith('rifiuta_paga_')) {
            await interaction.deferUpdate();
            
            const prestitoId = interaction.customId.split('_')[2];
            const result = await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId]);
            const prestito = result.rows[0];
            
            if (interaction.user.id !== prestito.mittente_id) {
                return safeReply(interaction, { content: '❌ Solo il mittente può rifiutare!', ephemeral: true });
            }
            
            await interaction.editReply({ content: '❌ Pagamento rifiutato dal mittente.', components: [] });
        }
        
        // ==================== SEGNA COME PAGATO ====================
        if (interaction.isButton() && interaction.customId.startsWith('completa_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const result = await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId]);
            const prestito = result.rows[0];
            
            if (!prestito) {
                return safeReply(interaction, { content: '❌ Prestito non trovato!', ephemeral: true });
            }
            
            if (prestito.debitore_id !== 'unknown' && interaction.user.id !== prestito.debitore_id) {
                return safeReply(interaction, { content: '❌ Solo il debitore può segnare come pagato!', ephemeral: true });
            }
            
            if (prestito.stato !== 'attivo') {
                return safeReply(interaction, { content: '❌ Prestito non attivo!', ephemeral: true });
            }
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`conferma_completa_${prestitoId}`)
                    .setLabel('Conferma')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`rifiuta_completa_${prestitoId}`)
                    .setLabel('Rifiuta')
                    .setStyle(ButtonStyle.Danger)
            );
            
            await safeReply(interaction, { 
                content: `✅ ${interaction.user} dichiara di aver pagato completamente.\n<@${prestito.mittente_id}> confermi?`,
                components: [row]
            });
        }
        
        // ==================== CONFERMA COMPLETAMENTO ====================
        if (interaction.isButton() && interaction.customId.startsWith('conferma_completa_')) {
            await interaction.deferUpdate();
            
            const prestitoId = interaction.customId.split('_')[2];
            const result = await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId]);
            const prestito = result.rows[0];
            
            if (interaction.user.id !== prestito.mittente_id) {
                return safeReply(interaction, { content: '❌ Solo il mittente può confermare!', ephemeral: true });
            }
            
            await query(
                'UPDATE prestiti SET stato = $1, importo_attuale = $2 WHERE id = $3',
                ['completato', 0, prestitoId]
            );
            
            await interaction.editReply({ 
                content: '✅ **Prestito completato!** 🎉', 
                components: [] 
            });
            
            // Aggiorna embed e archivia
            try {
                const thread = await client.channels.fetch(prestito.thread_id);
                const messages = await thread.messages.fetch({ limit: 10 });
                const firstMsg = Array.from(messages.values()).find(m => 
                    m.author.id === client.user.id && m.embeds.length > 0
                );
                
                if (firstMsg) {
                    const prestitoAggiornato = (await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId])).rows[0];
                    const embed = await creaEmbedPrestito(prestitoAggiornato, interaction.guild);
                    await firstMsg.edit({ embeds: [embed], components: [] });
                }
                
                await thread.setArchived(true);
            } catch (err) {
                console.error('Errore archiviazione:', err.message);
            }
        }
        
        // ==================== RIFIUTA COMPLETAMENTO ====================
        if (interaction.isButton() && interaction.customId.startsWith('rifiuta_completa_')) {
            await interaction.deferUpdate();
            
            const prestitoId = interaction.customId.split('_')[2];
            const result = await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId]);
            const prestito = result.rows[0];
            
            if (interaction.user.id !== prestito.mittente_id) {
                return safeReply(interaction, { content: '❌ Solo il mittente può rifiutare!', ephemeral: true });
            }
            
            await interaction.editReply({ content: '❌ Completamento rifiutato dal mittente.', components: [] });
        }
        
        // ==================== CHIUDI PRESTITO (MITTENTE) ====================
        if (interaction.isButton() && interaction.customId.startsWith('chiudi_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const result = await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId]);
            const prestito = result.rows[0];
            
            if (!prestito) {
                return safeReply(interaction, { content: '❌ Prestito non trovato!', ephemeral: true });
            }
            
            if (interaction.user.id !== prestito.mittente_id) {
                return safeReply(interaction, { content: '❌ Solo il mittente può chiudere!', ephemeral: true });
            }
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`conferma_chiudi_${prestitoId}`)
                    .setLabel('Sì, chiudi')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`annulla_chiudi_${prestitoId}`)
                    .setLabel('Annulla')
                    .setStyle(ButtonStyle.Secondary)
            );
            
            await safeReply(interaction, { 
                content: '⚠️ Sei sicuro di voler chiudere questo prestito? Questa azione è irreversibile.',
                components: [row],
                ephemeral: true
            });
        }
        
        // ==================== CONFERMA CHIUSURA ====================
        if (interaction.isButton() && interaction.customId.startsWith('conferma_chiudi_')) {
            await interaction.deferUpdate();
            
            const prestitoId = interaction.customId.split('_')[2];
            const result = await query('SELECT * FROM prestiti WHERE id = $1', [prestitoId]);
            const prestito = result.rows[0];
            
            if (!prestito || interaction.user.id !== prestito.mittente_id) {
                return safeReply(interaction, { content: '❌ Non autorizzato.', ephemeral: true });
            }
            
            await query('UPDATE prestiti SET stato = $1 WHERE id = $2', ['completato', prestitoId]);
            
            await interaction.editReply({ content: '🔒 Prestito chiuso dal mittente.', components: [] });
            
            // Archivia thread
            try {
                const thread = await client.channels.fetch(prestito.thread_id);
                if (thread && thread.isThread()) {
                    await thread.setArchived(true);
                    setTimeout(() => thread.delete().catch(() => {}), 5000);
                }
            } catch (err) {
                console.error('Errore chiusura thread:', err.message);
            }
        }
        
        // ==================== ANNULLA CHIUSURA ====================
        if (interaction.isButton() && interaction.customId.startsWith('annulla_chiudi_')) {
            await interaction.deferUpdate();
            await interaction.editReply({ content: '⏸ Chiusura annullata.', components: [] });
        }
        
    } catch (error) {
        console.error('❌ Errore interazione:', error);
        console.error('Stack:', error.stack);
        
        try {
            const errorMsg = { content: '❌ Si è verificato un errore. Riprova.', ephemeral: true };
            
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply(errorMsg).catch(() => {});
            } else {
                await interaction.followUp(errorMsg).catch(() => {});
            }
        } catch (err) {
            console.error('Impossibile inviare messaggio di errore:', err.message);
        }
    }
});

// ==================== ERROR HANDLERS ====================
client.on('error', error => {
    console.error('❌ Discord client error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise);
    console.error('Reason:', reason);
});

process.on('uncaughtException', error => {
    console.error('❌ Uncaught Exception:', error);
    console.error('Stack:', error.stack);
    
    // Graceful shutdown
    console.log('Tentativo graceful shutdown...');
    server.close(() => {
        client.destroy();
        pool.end(() => {
            console.log('Database pool chiuso');
            process.exit(1);
        });
    });
    
    // Force exit dopo 10 secondi
    setTimeout(() => {
        console.error('Forzo uscita dopo timeout');
        process.exit(1);
    }, 10000);
});

// ==================== GRACEFUL SHUTDOWN ====================
process.on('SIGTERM', () => {
    console.log('📥 SIGTERM ricevuto, chiusura graceful...');
    
    server.close(() => {
        console.log('✅ Server HTTP chiuso');
        
        client.destroy();
        console.log('✅ Bot disconnesso');
        
        pool.end(() => {
            console.log('✅ Database pool chiuso');
            process.exit(0);
        });
    });
});

process.on('SIGINT', () => {
    console.log('📥 SIGINT ricevuto, chiusura graceful...');
    
    server.close(() => {
        console.log('✅ Server HTTP chiuso');
        
        client.destroy();
        console.log('✅ Bot disconnesso');
        
        pool.end(() => {
            console.log('✅ Database pool chiuso');
            process.exit(0);
        });
    });
});

// ==================== AVVIO BOT ====================
console.log('🚀 Avvio BlockDebt Bot...');
console.log('📍 Ambiente:', process.env.NODE_ENV || 'development');

client.login(CONFIG.TOKEN).catch(error => {
    console.error('❌ Login fallito:', error);
    process.exit(1);
});