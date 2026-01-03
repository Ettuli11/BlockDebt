// BlockDebt - Bot Discord per gestione prestiti Minecraft
// Requisiti: npm install discord.js better-sqlite3

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits } = require('discord.js');
const Database = require('better-sqlite3');
const db = new Database('blockdebt.db');

// ==================== CONFIGURAZIONE ====================
const CONFIG = {
    TOKEN: 'IL_TUO_TOKEN_QUI',
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
    
    const emoji = {
        'Soldi': '💰',
        'Item': '📦',
        'Kill': '☠',
        'Info': 'ℹ'
    };
    
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

// ==================== BOT ====================
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.once('ready', async () => {
    console.log(`✅ BlockDebt online come ${client.user.tag}`);
    
    // Invia messaggio iniziale
    const channel = await client.channels.fetch(CONFIG.PRESTITI_CHANNEL_ID);
    if (channel) {
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
    
    // Timer per incrementi giornalieri
    setInterval(() => {
        const prestitiAttivi = db.prepare('SELECT * FROM prestiti WHERE stato = ?').all('attivo');
        prestitiAttivi.forEach(prestito => {
            calcolaIncrementi(prestito);
            const thread = client.channels.cache.get(prestito.thread_id);
            if (thread) {
                const embed = creaEmbedPrestito(prestito, thread.guild);
                thread.messages.fetch({ limit: 1 }).then(messages => {
                    const firstMsg = messages.first();
                    if (firstMsg && firstMsg.author.id === client.user.id) {
                        firstMsg.edit({ embeds: [embed] });
                    }
                });
            }
        });
    }, 3600000); // Controlla ogni ora
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
            
            // Cerca debitore
            const members = await interaction.guild.members.fetch({ query: debitore, limit: 1 });
            let debitoreId = null;
            let debitoreNome = debitore;
            
            if (members.size > 0) {
                const member = members.first();
                debitoreId = member.id;
                debitoreNome = member.user.username;
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
            
            // Crea thread
            const threadName = `prestito-${prestitoId}-${debitoreNome}-${categoria}`;
            const thread = await interaction.channel.threads.create({
                name: threadName,
                type: ChannelType.PrivateThread,
                reason: `Prestito #${prestitoId}`
            });
            
            // Aggiorna thread_id
            db.prepare('UPDATE prestiti SET thread_id = ? WHERE id = ?').run(thread.id, prestitoId);
            
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            const embed = creaEmbedPrestito(prestito, interaction.guild);
            
            const row1 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`accetta_${prestitoId}`).setLabel('Accetta prestito').setEmoji('✅').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`declina_${prestitoId}`).setLabel('Declina prestito').setEmoji('❌').setStyle(ButtonStyle.Danger)
                );
            
            const row2 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`chiudi_${prestitoId}`).setLabel('Chiudi il Prestito').setEmoji('🔒').setStyle(ButtonStyle.Primary)
                );
            
            await thread.send({ embeds: [embed], components: [row1, row2] });
            
            if (debitoreId) {
                await thread.members.add(debitoreId);
            }
            await thread.members.add(interaction.user.id);
            
            await interaction.reply({ content: `✅ Prestito #${prestitoId} creato! Controlla il thread ${thread}`, ephemeral: true });
        }
        
        // RICHIESTA CONFERMA CHIUSURA PRESTITO
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
                new ButtonBuilder().setCustomId(`conferma_chiudi_${prestitoId}`).setLabel('Sì').setEmoji('✅').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`annulla_chiudi_${prestitoId}`).setLabel('No').setEmoji('❌').setStyle(ButtonStyle.Secondary)
            );

            await interaction.reply({
                content: '⚠️ **Cliccando conferma chiuderai il prestito e non sarà più possibile accederci.**\nContinuare?',
                components: [row],
                ephemeral: true
            });
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
                    await thread.setArchived(true);
                    setTimeout(async () => {
                        await thread.delete('Prestito chiuso dal mittente');
                    }, 3000);
                }
            } catch (err) {
                console.error(err);
            }
        }

        // ANNULLA CHIUSURA PRESTITO
        if (interaction.isButton() && interaction.customId.startsWith('annulla_chiudi_')) {
            await interaction.update({ content: '⏎ Operazione annullata.', components: [] });
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
            
            const embed = creaEmbedPrestito(prestito, interaction.guild);
            
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`paga_${prestitoId}`).setLabel('Paga parzialmente').setEmoji('💸').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`completa_${prestitoId}`).setLabel('Segna come pagato').setEmoji('✅').setStyle(ButtonStyle.Success)
                );
            
            await interaction.update({ embeds: [embed], components: [row] });
            await interaction.followUp({ content: '✅ Prestito accettato! Il contatore è partito.', ephemeral: true });
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
            
            const embed = creaEmbedPrestito(prestito, interaction.guild);
            await interaction.update({ embeds: [embed], components: [] });
            
            const mittente = await client.users.fetch(prestito.mittente_id);
            await mittente.send(`⚠️ Attenzione ⚠️ Il Thread prestito-${prestitoId}-${prestito.debitore_nome}-${prestito.categoria.toLowerCase()} è stato declinato ❌ da ${prestito.debitore_nome}.`);
            
            const thread = await client.channels.fetch(prestito.thread_id);
            await thread.setArchived(true);
        }
        
        // PAGA PARZIALMENTE
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
                .setLabel('Importo da pagare')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            
            modal.addComponents(new ActionRowBuilder().addComponents(importoInput));
            await interaction.showModal(modal);
        }
        
        // SUBMIT PAGAMENTO
        if (interaction.isModalSubmit() && interaction.customId.startsWith('paga_modal_')) {
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            
            calcolaIncrementi(prestito);
            const prestitoAggiornato = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            
            const importoRaw = interaction.fields.getTextInputValue('importo');
            const importo = parseNumero(importoRaw);
            
            if (!importo || importo <= 0) {
                return interaction.reply({ content: '❌ Importo non valido!', ephemeral: true });
            }
            
            let importoAttuale = prestitoAggiornato.importo_attuale;
            if (prestitoAggiornato.categoria === 'Item' || prestitoAggiornato.categoria === 'Kill') {
                importoAttuale = arrotondaItem(prestitoAggiornato.valore_reale || prestitoAggiornato.importo_attuale);
            }
            
            if (importo > importoAttuale) {
                return interaction.reply({ content: `❌ Non puoi pagare più dell'importo rimanente (${formattaNumero(importoAttuale)})!`, ephemeral: true });
            }
            
            db.prepare('INSERT INTO pagamenti (prestito_id, importo, data) VALUES (?, ?, ?)')
                .run(prestitoId, importo, new Date().toISOString());
            
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`conferma_paga_${prestitoId}_${importo}`).setLabel('Conferma').setEmoji('✔').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`rifiuta_paga_${prestitoId}`).setLabel('Rifiuta').setEmoji('✖').setStyle(ButtonStyle.Danger)
                );
            
            await interaction.reply({ 
                content: `💸 ${interaction.user} ha effettuato un pagamento di ${formattaNumero(importo)}.\n<@${prestito.mittente_id}> confermi?`,
                components: [row]
            });
        }
        
        // CONFERMA PAGAMENTO
        if (interaction.isButton() && interaction.customId.startsWith('conferma_paga_')) {
            const parts = interaction.customId.split('_');
            const prestitoId = parts[2];
            const importo = parseFloat(parts[3]);
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            
            if (interaction.user.id !== prestito.mittente_id) {
                return interaction.reply({ content: '❌ Solo il mittente può confermare!', ephemeral: true });
            }
            
            calcolaIncrementi(prestito);
            const prestitoAggiornato = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            
            let nuovoImporto;
            if (prestitoAggiornato.categoria === 'Soldi') {
                nuovoImporto = prestitoAggiornato.importo_attuale - importo;
            } else if (prestitoAggiornato.categoria === 'Item' || prestitoAggiornato.categoria === 'Kill') {
                const nuovoValoreReale = (prestitoAggiornato.valore_reale || prestitoAggiornato.importo_attuale) - importo;
                db.prepare('UPDATE prestiti SET valore_reale = ? WHERE id = ?').run(nuovoValoreReale, prestitoId);
                nuovoImporto = nuovoValoreReale;
            }
            
            if (nuovoImporto <= 0.01) {
                db.prepare('UPDATE prestiti SET stato = ?, importo_attuale = 0 WHERE id = ?').run('completato', prestitoId);
                await interaction.update({ content: '✅ Pagamento confermato! Prestito completato! 🎉', components: [] });
                
                const embed = creaEmbedPrestito(prestitoAggiornato, interaction.guild);
                const thread = await client.channels.fetch(prestito.thread_id);
                const messages = await thread.messages.fetch({ limit: 1 });
                const firstMsg = messages.first();
                if (firstMsg) await firstMsg.edit({ embeds: [embed], components: [] });
                await thread.setArchived(true);
            } else {
                if (prestitoAggiornato.categoria === 'Soldi') {
                    db.prepare('UPDATE prestiti SET importo_attuale = ? WHERE id = ?').run(nuovoImporto, prestitoId);
                }
                
                await interaction.update({ content: `✅ Pagamento confermato! Nuovo saldo: ${formattaNumero(nuovoImporto)}`, components: [] });
                
                const embed = creaEmbedPrestito(prestitoAggiornato, interaction.guild);
                const thread = await client.channels.fetch(prestito.thread_id);
                const messages = await thread.messages.fetch({ limit: 1 });
                const firstMsg = messages.first();
                if (firstMsg) await firstMsg.edit({ embeds: [embed] });
            }
        }
        
        // RIFIUTA PAGAMENTO
        if (interaction.isButton() && interaction.customId.startsWith('rifiuta_paga_')) {
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            
            if (interaction.user.id !== prestito.mittente_id) {
                return interaction.reply({ content: '❌ Solo il mittente può rifiutare!', ephemeral: true });
            }
            
            await interaction.update({ content: '❌ Pagamento rifiutato dal mittente.', components: [] });
        }
        
        // COMPLETA PRESTITO
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
            
            await interaction.reply({ 
                content: `✅ ${interaction.user} ha segnato il prestito come pagato.\n<@${prestito.mittente_id}> confermi?`,
                components: [row]
            });
        }
        
        // CONFERMA COMPLETAMENTO
        if (interaction.isButton() && interaction.customId.startsWith('conferma_completa_')) {
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            
            if (interaction.user.id !== prestito.mittente_id) {
                return interaction.reply({ content: '❌ Solo il mittente può confermare!', ephemeral: true });
            }
            
            db.prepare('UPDATE prestiti SET stato = ?, importo_attuale = 0 WHERE id = ?').run('completato', prestitoId);
            
            await interaction.update({ content: '✅ Prestito completato! 🎉', components: [] });
            
            const embed = creaEmbedPrestito(prestito, interaction.guild);
            const thread = await client.channels.fetch(prestito.thread_id);
            const messages = await thread.messages.fetch({ limit: 1 });
            const firstMsg = messages.first();
            if (firstMsg) await firstMsg.edit({ embeds: [embed], components: [] });
            await thread.setArchived(true);
        }
        
        // RIFIUTA COMPLETAMENTO
        if (interaction.isButton() && interaction.customId.startsWith('rifiuta_completa_')) {
            const prestitoId = interaction.customId.split('_')[2];
            const prestito = db.prepare('SELECT * FROM prestiti WHERE id = ?').get(prestitoId);
            
            if (interaction.user.id !== prestito.mittente_id) {
                return interaction.reply({ content: '❌ Solo il mittente può rifiutare!', ephemeral: true });
            }
            
            await interaction.update({ content: '❌ Completamento rifiutato dal mittente.', components: [] });
        }
        
    } catch (error) {
        console.error('Errore:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ Si è verificato un errore!', ephemeral: true });
        }
    }
});

client.login(CONFIG.TOKEN);