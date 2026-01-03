// BlockDebt - Bot Discord per gestione prestiti Minecraft
// Requisiti: npm install discord.js better-sqlite3

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType } = require('discord.js');
const Database = require('better-sqlite3');
const db = new Database('blockdebt.db');

// ==================== CONFIGURAZIONE ====================
const CONFIG = {
    TOKEN: process.env.DISCORD_TOKEN,
    PRESTITI_CHANNEL_ID: '1456768128880082995',
    HOLIDAYS: [] // Array di date in formato 'YYYY-MM-DD' per le festività
};

// ==================== DATABASE ====================
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

// ==================== UTILITÀ ====================
/**
 * formattaNumero:
 * - 1.000 -> 1k
 * - 1.000.000 -> 1m
 * - 1.000.000.000 -> 1M
 * - 1.000.000.000.000 -> 1T
 * massimi 3 decimali, rimuove trailing zeros
 */
function formattaNumero(num) {
    if (num === null || num === undefined) return '0';
    const n = Number(num);
    const absNum = Math.abs(n);
    if (absNum >= 1e12) return (n / 1e12).toFixed(3).replace(/\.?0+$/, '') + 'T';
    if (absNum >= 1e9) return (n / 1e9).toFixed(3).replace(/\.?0+$/, '') + 'M';
    if (absNum >= 1e6) return (n / 1e6).toFixed(3).replace(/\.?0+$/, '') + 'm';
    if (absNum >= 1e3) return (n / 1e3).toFixed(3).replace(/\.?0+$/, '') + 'k';
    return n.toFixed(3).replace(/\.?0+$/, '');
}

/**
 * parseNumero:
 * accetta numeri con suffissi:
 * k/K -> 1e3
 * m -> 1e6
 * M -> 1e9
 * t/T -> 1e12
 * accetta anche "1.05m" o "1,050,000" (rimuove virgole)
 */
function parseNumero(str) {
    if (typeof str === 'number') return str;
    if (!str || typeof str !== 'string') return null;
    let s = str.trim();
    // rimuovi separatori di migliaia comuni
    s = s.replace(/,/g, '');
    const match = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*([kKmMtM]?)$/);
    if (!match) return null;
    const value = parseFloat(match[1]);
    const suffix = match[2] || '';
    if (!suffix) return value;
    if (suffix === 'k' || suffix === 'K') return value * 1e3;
    if (suffix === 'm') return value * 1e6;
    if (suffix === 'M') return value * 1e9;
    if (suffix === 't' || suffix === 'T') return value * 1e12;
    return value;
}

/**
 * arrotondaItem: regola per item/kill.
 * Se la parte decimale >= 0.5 -> ceil, else floor.
 * Restituisce int.
 */
function arrotondaItem(valoreReale) {
    const v = Number(valoreReale);
    if (Number.isNaN(v)) return 0;
    const decimale = v - Math.floor(v);
    return decimale >= 0.5 ? Math.ceil(v) : Math.floor(v);
}

function isHoliday(date) {
    const dateStr = date.toISOString().split('T')[0];
    return CONFIG.HOLIDAYS.includes(dateStr);
}

/**
 * calcolaIncrementi: aggiorna importi basandosi su giorni passati (esclude festività)
 * - Soldi: compounding 3% al giorno (importo_attuale * 1.03^giorni)
 * - Item/Kill: aggiunge ogni giorno il 3% dell'originale (importo_originale * 0.03 * giorni)
 *   (il valoreReale viene aggiornato; l'arrotondamento per visualizzazione è gestito a parte)
 */
function calcolaIncrementi(prestito) {
    if (!prestito || !prestito.data_accettazione) return;

    const categoria = (prestito.categoria || '').toLowerCase();
    if (categoria === 'info') return;

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

    if (giorniPassati <= 0) return;

    try {
        if (categoria === 'soldi') {
            const nuovoImporto = prestito.importo_attuale * Math.pow(1.03, giorniPassati);
            db.prepare('UPDATE prestiti SET importo_attuale = ?, ultimo_incremento = ? WHERE id = ?')
                .run(nuovoImporto, now.toISOString(), prestito.id);
        } else if (categoria === 'item' || categoria === 'kill') {
            const valoreBase = (prestito.valore_reale || prestito.importo_originale);
            // aggiunta totale = original * 0.03 * giorniPassati (come richiesto)
            const incrementoTotale = prestito.importo_originale * 0.03 * giorniPassati;
            const nuovoValore = valoreBase + incrementoTotale;
            db.prepare('UPDATE prestiti SET valore_reale = ?, ultimo_incremento = ? WHERE id = ?')
                .run(nuovoValore, now.toISOString(), prestito.id);
        }
    } catch (e) {
        console.error('Errore calcolaIncrementi:', e);
    }
}

// ==================== EMBED ====================
function creaEmbedPrestito(prestitoRecord) {
    if (!prestitoRecord) return new EmbedBuilder().setDescription('Prestito non trovato.');

    // ricalcola (lazy) e ricarica dal DB
    calcolaIncrementi(prestitoRecord);
    const p = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoRecord.id);
    if (!p) return new EmbedBuilder().setDescription('Prestito non trovato.');

    const categoriaKey = (p.categoria || '').toLowerCase();

    let importoVisualizzato;
    if (categoriaKey === 'item' || categoriaKey === 'kill') {
        importoVisualizzato = arrotondaItem(p.valore_reale || p.importo_attuale);
    } else {
        importoVisualizzato = p.importo_attuale;
    }

    const emoji = {
        'soldi': '💰',
        'item': '📦',
        'kill': '☠',
        'info': 'ℹ'
    };

    const stati = {
        'attesa': '🟡 IN ATTESA DI ACCETTAZIONE',
        'declinato': '❌ DECLINATO',
        'attivo': '🟢 ATTIVO',
        'completato': '✅ COMPLETATO'
    };

    const embed = new EmbedBuilder()
        .setColor(p.stato === 'attivo' ? '#00ff00' : p.stato === 'declinato' ? '#ff0000' : '#ffff00')
        .setTitle(`${emoji[categoriaKey] || ''} Prestito #${p.id} — ${p.categoria}`)
        .addFields(
            { name: '🟢 Mittente', value: p.mittente_nome || 'N/A', inline: true },
            { name: '🔴 Debitore', value: p.debitore_nome || 'N/A', inline: true },
            { name: '📂 Categoria', value: p.categoria || 'N/A', inline: true },
            { name: '📦 Importo originale', value: categoriaKey === 'soldi' ? formattaNumero(p.importo_originale) : String(p.importo_originale), inline: true },
            { name: '🔄 Importo attuale', value: categoriaKey === 'soldi' ? formattaNumero(importoVisualizzato) : String(importoVisualizzato), inline: true },
            { name: '📅 Data creazione', value: new Date(p.data_creazione).toLocaleDateString('it-IT'), inline: true }
        )
        .setFooter({ text: `Stato: ${stati[p.stato] || p.stato}` })
        .setTimestamp();

    if (p.prove) embed.addFields({ name: '🖼 Prove', value: p.prove });

    return embed;
}

// ==================== BOT ====================
// aggiunti GuildMembers e MessageContent intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ]
});

client.once('ready', async () => {
    console.log(`✅ BlockDebt online come ${client.user.tag}`);

    // Invia messaggio iniziale (se il canale esiste)
    try {
        const channel = await client.channels.fetch(CONFIG.PRESTITI_CHANNEL_ID).catch(()=>null);
        if (channel && channel.isTextBased && channel.send) {
            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('📄 Prestiti')
                .setDescription('Scegli una categoria per avviare un prestito');

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId('cat_soldi').setLabel('Soldi').setEmoji('💰').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('cat_item').setLabel('Item').setEmoji('📦').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('cat_kill').setLabel('Kill').setEmoji('☠').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('cat_info').setLabel('Info').setEmoji('ℹ').setStyle(ButtonStyle.Primary)
                );

            await channel.send({ embeds: [embed], components: [row] });
        }
    } catch (e) {
        console.error('Errore invio messaggio iniziale:', e);
    }

    // Timer opzionale (fallback) - non affidabile su hosting free ma lo lasciamo per sicurezza
    setInterval(() => {
        try {
            const prestitiAttivi = db.prepare('SELECT * FROM prestiti WHERE stato = ?').all('attivo');
            prestitiAttivi.forEach(prestito => {
                try {
                    calcolaIncrementi(prestito);
                    const thread = client.channels.cache.get(prestito.thread_id);
                    if (thread) {
                        const embed = creaEmbedPrestito(prestito);
                        thread.messages.fetch({ limit: 1 }).then(messages => {
                            const firstMsg = messages.first();
                            if (firstMsg && firstMsg.author.id === client.user.id) {
                                firstMsg.edit({ embeds: [embed] }).catch(()=>{});
                            }
                        }).catch(()=>{});
                    }
                } catch (e) { console.error('Errore timer inner:', e); }
            });
        } catch (e) { console.error('Errore timer outer:', e); }
    }, 3600000);
});

// ==================== AGGIORNA SU SCRITTA NEL THREAD ====================
client.on('messageCreate', async message => {
    try {
        if (message.author.bot) return;
        if (!(message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread)) return;

        const prestito = db.prepare('SELECT * FROM prestiti WHERE thread_id = ?').get(message.channel.id);
        if (!prestito) return;

        calcolaIncrementi(prestito);
        const p = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestito.id);
        const embed = creaEmbedPrestito(p);
        const msgs = await message.channel.messages.fetch({ limit: 1 });
        const firstMsg = msgs.first();
        if (firstMsg && firstMsg.author.id === client.user.id) {
            await firstMsg.edit({ embeds: [embed] }).catch(()=>{});
        }
    } catch (e) {
        console.error('Errore messageCreate:', e);
    }
});

// ==================== GESTIONE INTERAZIONI ====================
client.on('interactionCreate', async interaction => {
    try {
        // PULSANTI CATEGORIA
        if (interaction.isButton() && interaction.customId.startsWith('cat_')) {
            const categoria = interaction.customId.replace('cat_', '');
            const categoriaNome = categoria.charAt(0).toUpperCase() + categoria.slice(1);

            const modal = new ModalBuilder()
                .setCustomId(`modal_${categoria}`)
                .setTitle(`Crea Prestito - ${categoriaNome}`);

            const mittenteInput = new TextInputBuilder()
                .setCustomId('mittente')
                .setLabel('Mittente (chi presta)')
                .setStyle(TextInputStyle.Short)
                .setValue(interaction.user.username)
                .setRequired(true);

            const debitoreInput = new TextInputBuilder()
                .setCustomId('debitore')
                .setLabel('Debitore (chi deve pagare)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            let importoLabel = 'Importo';
            if (categoria === 'item') importoLabel = 'Item (nome e quantità)';
            else if (categoria === 'kill') importoLabel = 'Kill (numero)';
            else if (categoria === 'info') importoLabel = 'Info (testo)';

            const importoInput = new TextInputBuilder()
                .setCustomId('importo')
                .setLabel(importoLabel)
                .setStyle(categoria === 'info' ? TextInputStyle.Paragraph : TextInputStyle.Short)
                .setRequired(true);

            const proveInput = new TextInputBuilder()
                .setCustomId('prove')
                .setLabel('Prove (facoltative) - immagine o link')
                .setStyle(TextInputStyle.Short)
                .setRequired(false);

            const dataInput = new TextInputBuilder()
                .setCustomId('data')
                .setLabel('Data (default: oggi)')
                .setStyle(TextInputStyle.Short)
                .setValue(new Date().toLocaleDateString('it-IT'))
                .setRequired(false);

            modal.addComponents(
                new ActionRowBuilder().addComponents(mittenteInput),
                new ActionRowBuilder().addComponents(debitoreInput),
                new ActionRowBuilder().addComponents(importoInput),
                new ActionRowBuilder().addComponents(proveInput),
                new ActionRowBuilder().addComponents(dataInput)
            );

            await interaction.showModal(modal);
            return;
        }

        // SUBMIT MODALE
        if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_')) {
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
                    return interaction.reply({ content: '❌ Importo non valido!', ephemeral: true });
                }
            } else if (categoria === 'kill') {
                importoNum = parseInt(importoRaw);
                if (isNaN(importoNum) || importoNum <= 0) {
                    return interaction.reply({ content: '❌ Numero kill non valido!', ephemeral: true });
                }
            } else {
                importoNum = importoRaw;
            }

            // Cerca debitore (ricerca più completa)
            let debitoreId = null;
            let debitoreNome = debitore;

            try {
                const membri = await interaction.guild.members.fetch();
                const member = membri.find(m =>
                    (m.user.username && m.user.username.toLowerCase() === debitore.toLowerCase()) ||
                    (m.displayName && m.displayName.toLowerCase() === debitore.toLowerCase())
                );
                if (member) {
                    debitoreId = member.id;
                    debitoreNome = member.user.username;
                }
            } catch (e) {
                console.error('Errore fetch membri:', e);
            }

            // Crea prestito
            const result = db.prepare(`
                INSERT INTO prestiti (mittente_id, mittente_nome, debitore_id, debitore_nome, categoria, 
                    importo_originale, importo_attuale, valore_reale, prove, data_creazione, stato, thread_id, guild_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                interaction.user.id,
                mittente,
                debitoreId || 'unknown',
                debitoreNome,
                categoriaNome,
                typeof importoNum === 'number' ? importoNum : 0,
                typeof importoNum === 'number' ? importoNum : 0,
                typeof importoNum === 'number' ? importoNum : null,
                prove,
                data,
                'attesa',
                'temp',
                interaction.guild.id
            );

            const prestitoId = result.lastInsertRowid;

            // Crea thread (public thread)
            const threadName = `prestito-${prestitoId}-${debitoreNome}-${categoria}`;
            const thread = await interaction.channel.threads.create({
                name: threadName,
                type: ChannelType.PublicThread,
                reason: `Prestito #${prestitoId}`
            });

            // Aggiorna thread_id
            db.prepare('UPDATE prestiti SET thread_id = ? WHERE id = ?').run(thread.id, prestitoId);

            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            const embed = creaEmbedPrestito(prestito);

            const row1 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`accetta_${prestitoId}`).setLabel('Accetta prestito').setEmoji('✅').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`declina_${prestitoId}`).setLabel('Declina prestito').setEmoji('❌').setStyle(ButtonStyle.Danger)
                );

            const row2 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`chiudi_${prestitoId}`).setLabel('Chiudi il prestito').setEmoji('🔒').setStyle(ButtonStyle.Secondary)
                );

            await thread.send({ embeds: [embed], components: [row1, row2] });

            if (debitoreId) {
                try { await thread.members.add(debitoreId); } catch(e){ console.error('Impossibile aggiungere membro al thread', e); }
            }
            try { await thread.members.add(interaction.user.id); } catch(e){}

            await interaction.reply({ content: `✅ Prestito #${prestitoId} creato! Controlla il thread ${thread}`, ephemeral: true });
            return;
        }

        // CHIUDI THREAD (richiesta conferma)
        if (interaction.isButton() && interaction.customId.startsWith('chiudi_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);

            if (!prestito) {
                return interaction.reply({ content: '❌ Prestito non trovato!', ephemeral: true });
            }

            if (interaction.user.id !== prestito.mittente_id) {
                return interaction.reply({ content: '❌ Solo il mittente può chiudere il prestito.', ephemeral: true });
            }

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`conferma_chiudi_${prestitoId}`)
                    .setLabel('Sì')
                    .setEmoji('✅')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`annulla_chiudi_${prestitoId}`)
                    .setLabel('No')
                    .setEmoji('❌')
                    .setStyle(ButtonStyle.Secondary)
            );

            await interaction.reply({
                content: '⚠️ **Cliccando conferma chiuderai il prestito e non sarà più possibile accederci.**\nContinuare?',
                components: [row],
                ephemeral: true
            });
            return;
        }

        // CONFERMA CHIUSURA PRESTITO
        if (interaction.isButton() && interaction.customId.startsWith('conferma_chiudi_')) {
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);

            if (!prestito) {
                return interaction.reply({ content: '❌ Prestito non trovato!', ephemeral: true });
            }
            if (interaction.user.id !== prestito.mittente_id) {
                return interaction.reply({ content: '❌ Non autorizzato.', ephemeral: true });
            }

            db.prepare('UPDATE prestiti SET stato = ? WHERE id = ?').run('completato', prestitoId);

            await interaction.update({ content: '🔒 Prestito chiuso con successo.', components: [] });

            try {
                const thread = await client.channels.fetch(prestito.thread_id);
                if (thread) {
                    await thread.setArchived(true).catch(()=>{});
                    setTimeout(async () => {
                        try { await thread.delete('Prestito chiuso dal mittente'); } catch(e){ console.error('Impossibile eliminare thread:', e); }
                    }, 3000);
                }
            } catch (err) {
                console.error(err);
            }
            return;
        }

        // ANNULLA CHIUSURA PRESTITO
        if (interaction.isButton() && interaction.customId.startsWith('annulla_chiudi_')) {
            await interaction.update({ content: '❎ Operazione annullata.', components: [] });
            return;
        }

        // ACCETTA PRESTITO
        if (interaction.isButton() && interaction.customId.startsWith('accetta_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);

            if (!prestito) return interaction.reply({ content: '❌ Prestito non trovato!', ephemeral: true });
            if (prestito.debitore_id !== 'unknown' && interaction.user.id !== prestito.debitore_id) {
                return interaction.reply({ content: '❌ Solo il debitore può accettare!', ephemeral: true });
            }

            db.prepare('UPDATE prestiti SET stato = ?, data_accettazione = ?, ultimo_incremento = ? WHERE id = ?')
                .run('attivo', new Date().toISOString(), new Date().toISOString(), prestitoId);

            const embed = creaEmbedPrestito(prestito);

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`aggiorna_${prestitoId}`).setLabel('Aggiorna calcoli').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`paga_${prestitoId}`).setLabel('Paga parzialmente').setEmoji('💸').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`completa_${prestitoId}`).setLabel('Segna come pagato').setEmoji('✅').setStyle(ButtonStyle.Success)
                );

            await interaction.update({ embeds: [embed], components: [row] });
            await interaction.followUp({ content: '✅ Prestito accettato! Il contatore è partito.', ephemeral: true });
            return;
        }

        // DECLINA PRESTITO
        if (interaction.isButton() && interaction.customId.startsWith('declina_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);

            if (!prestito) return interaction.reply({ content: '❌ Prestito non trovato!', ephemeral: true });
            if (prestito.debitore_id !== 'unknown' && interaction.user.id !== prestito.debitore_id) {
                return interaction.reply({ content: '❌ Solo il debitore può declinare!', ephemeral: true });
            }

            db.prepare('UPDATE prestiti SET stato = ? WHERE id = ?').run('declinato', prestitoId);

            const embed = creaEmbedPrestito(prestito);
            await interaction.update({ embeds: [embed], components: [] });

            try {
                const mittente = await client.users.fetch(prestito.mittente_id).catch(()=>null);
                if (mittente) await mittente.send(`Il Thread prestito-${prestitoId}-${prestito.debitore_nome}-${prestito.categoria.toLowerCase()} è stato declinato da ${prestito.debitore_nome}.`).catch(()=>{});
            } catch(e){ console.error(e); }

            try {
                const thread = await client.channels.fetch(prestito.thread_id);
                if (thread) await thread.setArchived(true).catch(()=>{});
            } catch(e){ console.error(e); }

            return;
        }

        // PAGA PARZIALMENTE (apre modal)
        if (interaction.isButton() && interaction.customId.startsWith('paga_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);

            if (!prestito) return interaction.reply({ content: '❌ Prestito non trovato!', ephemeral: true });
            if (prestito.debitore_id !== 'unknown' && interaction.user.id !== prestito.debitore_id) {
                return interaction.reply({ content: '❌ Solo il debitore può pagare!', ephemeral: true });
            }

            const modal = new ModalBuilder()
                .setCustomId(`paga_modal_${prestitoId}`)
                .setTitle('Pagamento Parziale');

            const importoInput = new TextInputBuilder()
                .setCustomId('importo')
                .setLabel('Importo da pagare (usa k/m/M/T se vuoi)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(importoInput));
            await interaction.showModal(modal);
            return;
        }

        // SUBMIT PAGAMENTO
        if (interaction.isModalSubmit() && interaction.customId.startsWith('paga_modal_')) {
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (!prestito) return interaction.reply({ content: '❌ Prestito non trovato!', ephemeral: true });

            calcolaIncrementi(prestito);
            const prestitoAggiornato = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);

            const importoRaw = interaction.fields.getTextInputValue('importo');
            const importo = parseNumero(importoRaw);

            if (!importo || importo <= 0) {
                return interaction.reply({ content: '❌ Importo non valido!', ephemeral: true });
            }

            // calcola importo attuale (considera item/kill)
            let importoAttuale = prestitoAggiornato.importo_attuale;
            const catLow = (prestitoAggiornato.categoria || '').toLowerCase();
            if (catLow === 'item' || catLow === 'kill') {
                importoAttuale = arrotondaItem(prestitoAggiornato.valore_reale || prestitoAggiornato.importo_attuale);
            }

            // max check: non si può pagare più del rimanente
            if (importo > importoAttuale) {
                return interaction.reply({ content: `❌ Non puoi pagare più dell'importo rimanente (${formattaNumero(importoAttuale)})!`, ephemeral: true });
            }

            // inserisci pagamento nella tabella (non ancora confermato)
            db.prepare('INSERT INTO pagamenti (prestito_id, importo, data) VALUES (?, ?, ?)')
                .run(prestitoId, importo, new Date().toISOString());

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`conferma_paga_${prestitoId}_${importo}`).setLabel('Conferma').setEmoji('✔').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`rifiuta_paga_${prestitoId}`).setLabel('Rifiuta').setEmoji('✖').setStyle(ButtonStyle.Danger)
                );

            await interaction.reply({
                content: `💸 ${interaction.user} ha effettuato un pagamento di ${formattaNumero(importo)}.\n<@${prestito.mittente_id}> confermi?`,
                components: [row],
                ephemeral: false
            });
            return;
        }

        // CONFERMA PAGAMENTO
        if (interaction.isButton() && interaction.customId.startsWith('conferma_paga_')) {
            const parts = interaction.customId.split('_');
            const prestitoId = parts[2];
            // importo potrebbe contenere punti - usiamo parseFloat
            const importo = parseFloat(parts.slice(3).join('_'));
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (!prestito) return interaction.reply({ content: '❌ Prestito non trovato!', ephemeral: true });

            if (interaction.user.id !== prestito.mittente_id) {
                return interaction.reply({ content: '❌ Solo il mittente può confermare!', ephemeral: true });
            }

            calcolaIncrementi(prestito);
            const prestitoAggiornato = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);

            const catLow2 = (prestitoAggiornato.categoria || '').toLowerCase();
            let nuovoImporto;
            if (catLow2 === 'soldi') {
                nuovoImporto = prestitoAggiornato.importo_attuale - importo;
                db.prepare('UPDATE prestiti SET importo_attuale = ? WHERE id = ?').run(nuovoImporto, prestitoId);
            } else if (catLow2 === 'item' || catLow2 === 'kill') {
                const nuovoValoreReale = (prestitoAggiornato.valore_reale || prestitoAggiornato.importo_attuale) - importo;
                db.prepare('UPDATE prestiti SET valore_reale = ? WHERE id = ?').run(nuovoValoreReale, prestitoId);
                nuovoImporto = nuovoValoreReale;
            } else {
                // categoria info o altro
                return interaction.reply({ content: '❌ Operazione non valida per questa categoria.', ephemeral: true });
            }

            if (nuovoImporto <= 0.01) {
                db.prepare('UPDATE prestiti SET stato = ?, importo_attuale = 0 WHERE id = ?').run('completato', prestitoId);
                await interaction.update({ content: '✅ Pagamento confermato! Prestito completato! 🎉', components: [] });

                try {
                    const thread = await client.channels.fetch(prestito.thread_id);
                    if (thread) {
                        const embed = creaEmbedPrestito(prestitoAggiornato);
                        const messages = await thread.messages.fetch({ limit: 1 });
                        const firstMsg = messages.first();
                        if (firstMsg && firstMsg.author.id === client.user.id) await firstMsg.edit({ embeds: [embed], components: [] }).catch(()=>{});
                        await thread.setArchived(true).catch(()=>{});
                    }
                } catch(e){ console.error(e); }
            } else {
                await interaction.update({ content: `✅ Pagamento confermato! Nuovo saldo: ${formattaNumero(nuovoImporto)}`, components: [] });

                try {
                    const thread = await client.channels.fetch(prestito.thread_id);
                    if (thread) {
                        const embed = creaEmbedPrestito(prestitoAggiornato);
                        const messages = await thread.messages.fetch({ limit: 1 });
                        const firstMsg = messages.first();
                        if (firstMsg && firstMsg.author.id === client.user.id) await firstMsg.edit({ embeds: [embed] }).catch(()=>{});
                    }
                } catch(e){ console.error(e); }
            }
            return;
        }

        // RIFIUTA PAGAMENTO
        if (interaction.isButton() && interaction.customId.startsWith('rifiuta_paga_')) {
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (!prestito) return interaction.reply({ content: '❌ Prestito non trovato!', ephemeral: true });
            if (interaction.user.id !== prestito.mittente_id) return interaction.reply({ content: '❌ Solo il mittente può rifiutare!', ephemeral: true });

            await interaction.update({ content: '❌ Pagamento rifiutato dal mittente.', components: [] });
            return;
        }

        // COMPLETA PRESTITO (il debitore segnala di aver pagato tutto)
        if (interaction.isButton() && interaction.customId.startsWith('completa_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (!prestito) return interaction.reply({ content: '❌ Prestito non trovato!', ephemeral: true });
            if (prestito.debitore_id !== 'unknown' && interaction.user.id !== prestito.debitore_id) {
                return interaction.reply({ content: '❌ Solo il debitore può completare!', ephemeral: true });
            }

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`conferma_completa_${prestitoId}`).setLabel('Conferma').setEmoji('✔').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`rifiuta_completa_${prestitoId}`).setLabel('Rifiuta').setEmoji('✖').setStyle(ButtonStyle.Danger)
                );

            await interaction.reply({ content: `✅ ${interaction.user} ha segnato il prestito come pagato.\n<@${prestito.mittente_id}> confermi?`, components: [row], ephemeral: false });
            return;
        }

        // CONFERMA COMPLETAMENTO
        if (interaction.isButton() && interaction.customId.startsWith('conferma_completa_')) {
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (!prestito) return interaction.reply({ content: '❌ Prestito non trovato!', ephemeral: true });
            if (interaction.user.id !== prestito.mittente_id) return interaction.reply({ content: '❌ Solo il mittente può confermare!', ephemeral: true });

            db.prepare('UPDATE prestiti SET stato = ?, importo_attuale = 0 WHERE id = ?').run('completato', prestitoId);
            await interaction.update({ content: '✅ Prestito completato! 🎉', components: [] });

            try {
                const embed = creaEmbedPrestito(prestito);
                const thread = await client.channels.fetch(prestito.thread_id);
                if (thread) {
                    const messages = await thread.messages.fetch({ limit: 1 });
                    const firstMsg = messages.first();
                    if (firstMsg && firstMsg.author.id === client.user.id) await firstMsg.edit({ embeds: [embed], components: [] }).catch(()=>{});
                    await thread.setArchived(true).catch(()=>{});
                }
            } catch(e){ console.error(e); }
            return;
        }

        // RIFIUTA COMPLETAMENTO
        if (interaction.isButton() && interaction.customId.startsWith('rifiuta_completa_')) {
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (!prestito) return interaction.reply({ content: '❌ Prestito non trovato!', ephemeral: true });
            if (interaction.user.id !== prestito.mittente_id) return interaction.reply({ content: '❌ Solo il mittente può rifiutare!', ephemeral: true });

            await interaction.update({ content: '❌ Completamento rifiutato dal mittente.', components: [] });
            return;
        }

        // AGGIORNA CALCOLI (pulsante)
        if (interaction.isButton() && interaction.customId.startsWith('aggiorna_')) {
            const prestitoId = interaction.customId.split('_')[1];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            if (!prestito) return interaction.reply({ content: '❌ Prestito non trovato!', ephemeral: true });

            calcolaIncrementi(prestito);
            const aggiornato = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            const embed = creaEmbedPrestito(aggiornato);

            try {
                const thread = await client.channels.fetch(aggiornato.thread_id);
                const messages = await thread.messages.fetch({ limit: 1 });
                const firstMsg = messages.first();
                if (firstMsg && firstMsg.author.id === client.user.id) {
                    await firstMsg.edit({ embeds: [embed] }).catch(()=>{});
                }
            } catch(e){ console.error(e); }

            await interaction.reply({ content: '🔄 Calcoli aggiornati correttamente.', ephemeral: true });
            return;
        }

    } catch (error) {
        console.error('Errore:', error);
        try {
            if (interaction && !interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Si è verificato un errore!', ephemeral: true });
            }
        } catch (e) { console.error('Errore reply catch:', e); }
    }
});

// ==================== LOGIN ====================
client.login(CONFIG.TOKEN);
