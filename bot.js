// BlockDebt - Bot Discord per gestione prestiti Minecraft
// Con Express per Render Free Web Service

const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType } = require('discord.js');
const Database = require('better-sqlite3');

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
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    if (botReady) {
        res.status(200).json({ status: 'healthy', bot: botUser.tag });
    } else {
        res.status(503).json({ status: 'starting' });
    }
});

const server = app.listen(PORT, () => {
    console.log(`🌐 Server HTTP attivo su porta ${PORT}`);
});

// ==================== DATABASE ====================
const db = new Database('blockdebt.db');

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
        thread_id TEXT NOT NULL,
        guild_id TEXT NOT NULL
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS pagamenti (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prestito_id INTEGER NOT NULL,
        importo REAL NOT NULL,
        data TEXT NOT NULL,
        confermato INTEGER DEFAULT 0,
        FOREIGN KEY (prestito_id) REFERENCES prestiti(id)
    )
`);

// ==================== CONFIGURAZIONE ====================
const CONFIG = {
    TOKEN: process.env.DISCORD_TOKEN,
    PRESTITI_CHANNEL_ID: process.env.CHANNEL_ID || '1456768128880082995',
    HOLIDAYS: []
};

if (!CONFIG.TOKEN) {
    console.error('❌ DISCORD_TOKEN mancante!');
    process.exit(1);
}

// ==================== UTILITÀ ====================
function formattaNumero(num) {
    const absNum = Math.abs(num);
    if (absNum >= 1e12) return (num / 1e12).toFixed(3).replace(/\.?0+$/, '') + 'T';
    if (absNum >= 1e9) return (num / 1e9).toFixed(3).replace(/\.?0+$/, '') + 'B';
    if (absNum >= 1e6) return (num / 1e6).toFixed(3).replace(/\.?0+$/, '') + 'm';
    if (absNum >= 1e3) return (num / 1e3).toFixed(3).replace(/\.?0+$/, '') + 'k';
    return num.toString();
}

function parseNumero(str) {
    str = str.toLowerCase().replace(/\s/g, '');
    const multipliers = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
    const match = str.match(/^([0-9.]+)([kmbt]?)$/);
    if (!match) return null;
    const num = parseFloat(match[1]);
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

function calcolaIncrementi(prestito) {
    if (!prestito.data_accettazione || prestito.categoria === 'Info') return;
    
    const now = new Date();
    const dataAccettazione = new Date(prestito.data_accettazione);
    const ultimoIncremento = prestito.ultimo_incremento ? new Date(prestito.ultimo_incremento) : dataAccettazione;
    
    let giorniPassati = 0;
    let currentDate = new Date(ultimoIncremento);
    currentDate.setDate(currentDate.getDate() + 1);
    
    while (currentDate <= now) {
        if (!isHoliday(currentDate)) {
            giorniPassati++;
        }
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    if (giorniPassati > 0) {
        if (prestito.categoria === 'Soldi') {
            const nuovoImporto = prestito.importo_attuale * Math.pow(1.03, giorniPassati);
            db.prepare('UPDATE prestiti SET importo_attuale = ?, ultimo_incremento = ? WHERE id = ?')
                .run(nuovoImporto, now.toISOString(), prestito.id);
        } else if (prestito.categoria === 'Item' || prestito.categoria === 'Kill') {
            const valoreReale = (prestito.valore_reale || prestito.importo_originale) + (prestito.importo_originale * 0.03 * giorniPassati);
            db.prepare('UPDATE prestiti SET valore_reale = ?, ultimo_incremento = ? WHERE id = ?')
                .run(valoreReale, now.toISOString(), prestito.id);
        }
    }
}

async function safeReply(interaction, options) {
    try {
        if (interaction.replied || interaction.deferred) {
            return await interaction.followUp(options);
        }
        return await interaction.reply(options);
    } catch (error) {
        console.error('Errore risposta:', error.message);
        return null;
    }
}

async function safeUpdate(interaction, options) {
    try {
        return await interaction.update(options);
    } catch (error) {
        console.error('Errore update:', error.message);
        return await safeReply(interaction, options);
    }
}

// ==================== EMBED ====================
function creaEmbedPrestito(prestito, guild) {
    calcolaIncrementi(prestito);
    const prestitoAggiornato = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestito.id);
    
    let importoVisualizzato;
    if (prestitoAggiornato.categoria === 'Item' || prestitoAggiornato.categoria === 'Kill') {
        importoVisualizzato = arrotondaItem(prestitoAggiornato.valore_reale || prestitoAggiornato.importo_attuale);
    } else {
        importoVisualizzato = prestitoAggiornato.importo_attuale;
    }
    
    const emoji = { 'Soldi': '💰', 'Item': '📦', 'Kill': '☠', 'Info': 'ℹ' };
    const stati = {
        'attesa': '🟡 IN ATTESA DI ACCETTAZIONE',
        'declinato': '❌ DECLINATO',
        'attivo': '🟢 ATTIVO',
        'completato': '✅ COMPLETATO'
    };
    
    const embed = new EmbedBuilder()
        .setColor(prestitoAggiornato.stato === 'attivo' ? '#00ff00' : prestitoAggiornato.stato === 'declinato' ? '#ff0000' : '#ffff00')
        .setTitle(`${emoji[prestitoAggiornato.categoria]} Prestito #${prestitoAggiornato.id} — ${prestitoAggiornato.categoria}`)
        .addFields(
            { name: '🟢 Mittente', value: prestitoAggiornato.mittente_nome, inline: true },
            { name: '🔴 Debitore', value: prestitoAggiornato.debitore_nome, inline: true },
            { name: '📂 Categoria', value: prestitoAggiornato.categoria, inline: true },
            { name: '📦 Importo originale', value: prestitoAggiornato.categoria === 'Soldi' ? formattaNumero(prestitoAggiornato.importo_originale) : prestitoAggiornato.importo_originale.toString(), inline: true },
            { name: '🔄 Importo attuale', value: prestitoAggiornato.categoria === 'Soldi' ? formattaNumero(importoVisualizzato) : importoVisualizzato.toString(), inline: true },
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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.once('ready', async () => {
    botReady = true;
    botUser = client.user;
    console.log(`✅ ${client.user.tag} online`);
    console.log(`📊 ${client.guilds.cache.size} server`);
    
    try {
        const channel = await client.channels.fetch(CONFIG.PRESTITI_CHANNEL_ID);
        if (channel) {
            console.log(`✅ Canale: #${channel.name}`);
            
            const messages = await channel.messages.fetch({ limit: 10 });
            const hasInit = messages.some(m => 
                m.author.id === client.user.id && 
                m.embeds[0]?.title === '📄 Prestiti'
            );
            
            if (!hasInit) {
                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('📄 Prestiti')
                    .setDescription('Scegli una categoria per avviare un prestito');
                
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('cat_soldi').setLabel('Soldi').setEmoji('💰').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('cat_item').setLabel('Item').setEmoji('📦').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('cat_kill').setLabel('Kill').setEmoji('☠').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('cat_info').setLabel('Info').setEmoji('ℹ').setStyle(ButtonStyle.Primary)
                );
                
                await channel.send({ embeds: [embed], components: [row] });
                console.log('✅ Messaggio iniziale inviato');
            }
        }
    } catch (error) {
        console.error('❌ Errore canale:', error.message);
    }
    
    setInterval(async () => {
        try {
            const prestitiAttivi = db.prepare('SELECT * FROM prestiti WHERE stato = ?').all('attivo');
            for (const prestito of prestitiAttivi) {
                calcolaIncrementi(prestito);
                try {
                    const thread = await client.channels.fetch(prestito.thread_id);
                    if (thread) {
                        const messages = await thread.messages.fetch({ limit: 1 });
                        const firstMsg = messages.first();
                        if (firstMsg?.author.id === client.user.id) {
                            const embed = creaEmbedPrestito(prestito, thread.guild);
                            await firstMsg.edit({ embeds: [embed] });
                        }
                    }
                } catch (err) {}
            }
        } catch (error) {
            console.error('Errore timer:', error);
        }
    }, 3600000);
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isButton() && interaction.customId.startsWith('cat_')) {
            const categoria = interaction.customId.replace('cat_', '');
            const categoriaNome = categoria.charAt(0).toUpperCase() + categoria.slice(1);
            
            const modal = new ModalBuilder()
                .setCustomId(`modal_${categoria}`)
                .setTitle(`Crea Prestito - ${categoriaNome}`);
            
            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('mittente')
                        .setLabel('Mittente (chi presta)')
                        .setStyle(TextInputStyle.Short)
                        .setValue(interaction.user.username)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('debitore')
                        .setLabel('Debitore (chi deve pagare)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('importo')
                        .setLabel(categoria === 'item' ? 'Item (nome e quantità)' : categoria === 'kill' ? 'Kill (numero)' : categoria === 'info' ? 'Info (testo)' : 'Importo')
                        .setStyle(categoria === 'info' ? TextInputStyle.Paragraph : TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('prove')
                        .setLabel('Prove (facoltative)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('data')
                        .setLabel('Data (default: oggi)')
                        .setStyle(TextInputStyle.Short)
                        .setValue(new Date().toLocaleDateString('it-IT'))
                        .setRequired(false)
                )
            );
            
            await interaction.showModal(modal);
        }
        
        if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_')) {
            await interaction.deferReply({ ephemeral: true });
            
            const categoria = interaction.customId.replace('modal_', '');
            const categoriaNome = categoria.charAt(0).toUpperCase() + categoria.slice(1);
            
            const mittente = interaction.fields.getTextInputValue('mittente');
            const debitore = interaction.fields.getTextInputValue('debitore');
            const importoRaw = interaction.fields.getTextInputValue('importo');
            const prove = interaction.fields.getTextInputValue('prove') || null;
            const data = interaction.fields.getTextInputValue('data') || new Date().toISOString();
            
            let importoNum;
            if (categoria === 'soldi') {
                importoNum = parseNumero(importoRaw);
                if (!importoNum || importoNum <= 0) {
                    return interaction.editReply({ content: '❌ Importo non valido!' });
                }
            } else if (categoria === 'kill') {
                importoNum = parseInt(importoRaw);
                if (isNaN(importoNum) || importoNum <= 0) {
                    return interaction.editReply({ content: '❌ Numero kill non valido!' });
                }
            } else {
                importoNum = importoRaw;
            }
            
            const members = await interaction.guild.members.fetch({ query: debitore, limit: 1 });
            let debitoreId = null;
            let debitoreNome = debitore;
            
            if (members.size > 0) {
                const member = members.first();
                debitoreId = member.id;
                debitoreNome = member.user.username;
            }
            
            const result = db.prepare(`
                INSERT INTO prestiti (mittente_id, mittente_nome, debitore_id, debitore_nome, categoria, 
                    importo_originale, importo_attuale, valore_reale, prove, data_creazione, stato, thread_id, guild_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                interaction.user.id, mittente, debitoreId || 'unknown', debitoreNome, categoriaNome,
                typeof importoNum === 'number' ? importoNum : 0,
                typeof importoNum === 'number' ? importoNum : 0,
                typeof importoNum === 'number' ? importoNum : null,
                prove, data, 'attesa', 'temp', interaction.guild.id
            );
            
            const prestitoId = result.lastInsertRowid;
            const threadName = `prestito-${prestitoId}-${debitoreNome}-${categoria}`;
            const thread = await interaction.channel.threads.create({
                name: threadName,
                type: ChannelType.PrivateThread,
                reason: `Prestito #${prestitoId}`
            });
            
            db.prepare('UPDATE prestiti SET thread_id = ? WHERE id = ?').run(thread.id, prestitoId);
            
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            const embed = creaEmbedPrestito(prestito, interaction.guild);
            
            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`accetta_${prestitoId}`).setLabel('Accetta').setEmoji('✅').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`declina_${prestitoId}`).setLabel('Declina').setEmoji('❌').setStyle(ButtonStyle.Danger)
            );
            
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`chiudi_${prestitoId}`).setLabel('Chiudi').setEmoji('🔒').setStyle(ButtonStyle.Secondary)
            );
            
            await thread.send({ embeds: [embed], components: [row1, row2] });
            if (debitoreId) await thread.members.add(debitoreId);
            await thread.members.add(interaction.user.id);
            
            await interaction.editReply({ content: `✅ Prestito #${prestitoId} creato! ${thread}` });
        }
        
        if (interaction.isButton() && interaction.customId.startsWith('chiudi_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (!prestito) return safeReply(interaction, { content: '❌ Non trovato!', ephemeral: true });
            if (interaction.user.id !== prestito.mittente_id) {
                return safeReply(interaction, { content: '❌ Solo mittente!', ephemeral: true });
            }
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`conferma_chiudi_${prestitoId}`).setLabel('Sì').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`annulla_chiudi_${prestitoId}`).setLabel('No').setStyle(ButtonStyle.Secondary)
            );
            await safeReply(interaction, { content: '⚠️ Confermi chiusura?', components: [row], ephemeral: true });
        }

        if (interaction.isButton() && interaction.customId.startsWith('conferma_chiudi_')) {
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (!prestito || interaction.user.id !== prestito.mittente_id) {
                return safeUpdate(interaction, { content: '❌ Non autorizzato.', components: [] });
            }
            db.prepare('UPDATE prestiti SET stato = ? WHERE id = ?').run('completato', prestitoId);
            await safeUpdate(interaction, { content: '🔒 Chiuso.', components: [] });
            try {
                const thread = await client.channels.fetch(prestito.thread_id);
                if (thread) {
                    await thread.setArchived(true);
                    setTimeout(() => thread.delete().catch(() => {}), 3000);
                }
            } catch (err) {}
        }

        if (interaction.isButton() && interaction.customId.startsWith('annulla_chiudi_')) {
            await safeUpdate(interaction, { content: '⏎ Annullato.', components: [] });
        }
        
        if (interaction.isButton() && interaction.customId.startsWith('accetta_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (!prestito) return safeReply(interaction, { content: '❌ Non trovato!', ephemeral: true });
            if (prestito.debitore_id !== 'unknown' && interaction.user.id !== prestito.debitore_id) {
                return safeReply(interaction, { content: '❌ Solo debitore!', ephemeral: true });
            }
            db.prepare('UPDATE prestiti SET stato = ?, data_accettazione = ?, ultimo_incremento = ? WHERE id = ?')
                .run('attivo', new Date().toISOString(), new Date().toISOString(), prestitoId);
            const embed = creaEmbedPrestito(prestito, interaction.guild);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`paga_${prestitoId}`).setLabel('Paga').setEmoji('💸').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`completa_${prestitoId}`).setLabel('Pagato').setEmoji('✅').setStyle(ButtonStyle.Success)
            );
            await safeUpdate(interaction, { embeds: [embed], components: [row] });
        }
        
        if (interaction.isButton() && interaction.customId.startsWith('declina_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (!prestito) return safeReply(interaction, { content: '❌ Non trovato!', ephemeral: true });
            if (prestito.debitore_id !== 'unknown' && interaction.user.id !== prestito.debitore_id) {
                return safeReply(interaction, { content: '❌ Solo debitore!', ephemeral: true });
            }
            db.prepare('UPDATE prestiti SET stato = ? WHERE id = ?').run('declinato', prestitoId);
            const embed = creaEmbedPrestito(prestito, interaction.guild);
            await safeUpdate(interaction, { embeds: [embed], components: [] });
            try {
                const mittente = await client.users.fetch(prestito.mittente_id);
                await mittente.send(`⚠️ Prestito #${prestitoId} declinato`);
            } catch (err) {}
            try {
                const thread = await client.channels.fetch(prestito.thread_id);
                await thread.setArchived(true);
            } catch (err) {}
        }
        
        if (interaction.isButton() && interaction.customId.startsWith('paga_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (!prestito) return safeReply(interaction, { content: '❌ Non trovato!', ephemeral: true });
            if (prestito.debitore_id !== 'unknown' && interaction.user.id !== prestito.debitore_id) {
                return safeReply(interaction, { content: '❌ Solo debitore!', ephemeral: true });
            }
            const modal = new ModalBuilder().setCustomId(`paga_modal_${prestitoId}`).setTitle('Pagamento');
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('importo').setLabel('Importo').setStyle(TextInputStyle.Short).setRequired(true)
            ));
            await interaction.showModal(modal);
        }
        
        if (interaction.isModalSubmit() && interaction.customId.startsWith('paga_modal_')) {
            await interaction.deferReply();
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            calcolaIncrementi(prestito);
            const prestitoAggiornato = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            const importoRaw = interaction.fields.getTextInputValue('importo');
            const importo = parseNumero(importoRaw);
            if (!importo || importo <= 0) return interaction.editReply({ content: '❌ Importo non valido!' });
            let importoAttuale = prestitoAggiornato.importo_attuale;
            if (prestitoAggiornato.categoria === 'Item' || prestitoAggiornato.categoria === 'Kill') {
                importoAttuale = arrotondaItem(prestitoAggiornato.valore_reale || prestitoAggiornato.importo_attuale);
            }
            if (importo > importoAttuale) return interaction.editReply({ content: `❌ Max: ${formattaNumero(importoAttuale)}!` });
            db.prepare('INSERT INTO pagamenti (prestito_id, importo, data) VALUES (?, ?, ?)')
                .run(prestitoId, importo, new Date().toISOString());
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`conferma_paga_${prestitoId}_${importo}`).setLabel('Conferma').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`rifiuta_paga_${prestitoId}`).setLabel('Rifiuta').setStyle(ButtonStyle.Danger)
            );
            await interaction.editReply({ content: `💸 ${formattaNumero(importo)}. <@${prestito.mittente_id}> confermi?`, components: [row] });
        }
        
        if (interaction.isButton() && interaction.customId.startsWith('conferma_paga_')) {
            const parts = interaction.customId.split('_');
            const prestitoId = parts[2];
            const importo = parseFloat(parts[3]);
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (interaction.user.id !== prestito.mittente_id) {
                return safeReply(interaction, { content: '❌ Solo mittente!', ephemeral: true });
            }
            calcolaIncrementi(prestito);
            const prestitoAggiornato = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            let nuovoImporto;
            if (prestitoAggiornato.categoria === 'Soldi') {
                nuovoImporto = prestitoAggiornato.importo_attuale - importo;
            } else {
                const nuovoValoreReale = (prestitoAggiornato.valore_reale || prestitoAggiornato.importo_attuale) - importo;
                db.prepare('UPDATE prestiti SET valore_reale = ? WHERE id = ?').run(nuovoValoreReale, prestitoId);
                nuovoImporto = nuovoValoreReale;
            }
            if (nuovoImporto <= 0.01) {
                db.prepare('UPDATE prestiti SET stato = ?, importo_attuale = 0 WHERE id = ?').run('completato', prestitoId);
                await safeUpdate(interaction, { content: '✅ Completato! 🎉', components: [] });
                try {
                    const thread = await client.channels.fetch(prestito.thread_id);
                    const messages = await thread.messages.fetch({ limit: 1 });
                    const firstMsg = messages.first();
                    if (firstMsg) {
                        const embed = creaEmbedPrestito(prestitoAggiornato, interaction.guild);
                        await firstMsg.edit({ embeds: [embed], components: [] });
                    }
                    await thread.setArchived(true);
                } catch (err) {}
            } else {
                if (prestitoAggiornato.categoria === 'Soldi') {
                    db.prepare('UPDATE prestiti SET importo_attuale = ? WHERE id = ?').run(nuovoImporto, prestitoId);
                }
                await safeUpdate(interaction, { content: `✅ Saldo: ${formattaNumero(nuovoImporto)}`, components: [] });
                try {
                    const thread = await client.channels.fetch(prestito.thread_id);
                    const messages = await thread.messages.fetch({ limit: 1 });
                    const firstMsg = messages.first();
                    if (firstMsg) {
                        const embed = creaEmbedPrestito(prestitoAggiornato, interaction.guild);
                        await firstMsg.edit({ embeds: [embed] });
                    }
                } catch (err) {}
            }
        }
        
        if (interaction.isButton() && interaction.customId.startsWith('rifiuta_paga_')) {
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (interaction.user.id !== prestito.mittente_id) {
                return safeReply(interaction, { content: '❌ Solo mittente!', ephemeral: true });
            }
            await safeUpdate(interaction, { content: '❌ Rifiutato.', components: [] });
        }
        
        if (interaction.isButton() && interaction.customId.startsWith('completa_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (!prestito) return safeReply(interaction, { content: '❌ Non trovato!', ephemeral: true });
            if (prestito.debitore_id !== 'unknown' && interaction.user.id !== prestito.debitore_id) {
                return safeReply(interaction, { content: '❌ Solo debitore!', ephemeral: true });
            }
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`conferma_completa_${prestitoId}`).setLabel('Conferma').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`rifiuta_completa_${prestitoId}`).setLabel('Rifiuta').setStyle(ButtonStyle.Danger)
            );
            await safeReply(interaction, { content: `✅ ${interaction.user} segna pagato. <@${prestito.mittente_id}> confermi?`, components: [row] });
        }
        
        if (interaction.isButton() && interaction.customId.startsWith('conferma_completa_')) {
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (interaction.user.id !== prestito.mittente_id) {
                return safeReply(interaction, { content: '❌ Solo mittente!', ephemeral: true });
            }
            db.prepare('UPDATE prestiti SET stato = ?, importo_attuale = 0 WHERE id = ?').run('completato', prestitoId);
            await safeUpdate(interaction, { content: '✅ Completato! 🎉', components: [] });
            try {
                const thread = await client.channels.fetch(prestito.thread_id);
                const messages = await thread.messages.fetch({ limit: 1 });
                const firstMsg = messages.first();
                if (firstMsg) {
                    const embed = creaEmbedPrestito(prestito, interaction.guild);
                    await firstMsg.edit({ embeds: [embed], components: [] });
                }
                await thread.setArchived(true);
            } catch (err) {}
        }
        
        if (interaction.isButton() && interaction.customId.startsWith('rifiuta_completa_')) {
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (interaction.user.id !== prestito.mittente_id) {
                return safeReply(interaction, { content: '❌ Solo mittente!', ephemeral: true });
            }
            await safeUpdate(interaction, { content: '❌ Rifiutato.', components: [] });
        }
        
    } catch (error) {
        console.error('Errore:', error.message);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Errore!', ephemeral: true });
            } else {
                await interaction.followUp({ content: '❌ Errore!', ephemeral: true });
            }
        } catch (err) {}
    }
});

// Gestione errori globali
process.on('unhandledRejection', error => console.error('Unhandled:', error));
process.on('uncaughtException', error => {
    console.error('Uncaught:', error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM ricevuto, chiusura...');
    server.close(() => {
        client.destroy();
        db.close();
        process.exit(0);
    });
});

// Avvio bot
client.login(CONFIG.TOKEN).catch(error => {
    console.error('❌ Login fallito:', error);
    process.exit(1);
});