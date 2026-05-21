import "reflect-metadata"
import { createConnection, Entity, Column, getManager } from "typeorm"
import { Telegraf, Markup } from "telegraf"
import * as fs from "fs"
import { BotConfigurator } from "../bot-processor/bot-configurator"
import { BotMessage } from "../bot-processor/bot-message"
import { ChatMember } from "../model/ChatMember"
import { MemberHistory } from "../model/MemberHistory"


export class BotProcessor {

    private botApiProcessor
    private botConfigurator
    private botMessage
    private dbConnection
    private chatAdmins
    private chatId
    private chatTitle: string = ''
    private botUsername: string = ''
    private lastConfigRule
    private started = false
    private handlersInitialized = false
    // Maps normalized name key → Set of admin IDs with that name
    // Supports multiple admins sharing the same normalized name
    private adminSet: Map<string, Set<number>> = new Map()
    private checkingMembers: Set<number> = new Set()  // prevents duplicate simultaneous checks
    private recentJoiners: Map<number, number> = new Map()  // memberId → join timestamp (epoch ms)

    private normalize(val: string | undefined): string {
        return val
            ? val
                .toLowerCase()
                .normalize("NFKD")
                .replace(/[^\p{L}\p{N}]/gu, '')
            : ''
    }

    constructor() {
        this.botConfigurator = new BotConfigurator()
        this.botMessage = new BotMessage()
        this.chatId = parseInt(this.botConfigurator.getConfiguration().chatId)
    }

    public async start() {
        if (this.started) {
            this.log("Bot already started. Skipping duplicate start.")
            return
        }

        this.started = true

        await this.connectToDatabase()

        this.botApiProcessor = new Telegraf(this.botConfigurator.getConfiguration().botToken)

        // Fetch bot username before registering handlers so /report@botname regex is correct
        try {
            const me = await this.botApiProcessor.telegram.getMe()
            this.botUsername = me.username || ''
        } catch (e) {
            this.log("Could not fetch bot username", { message: e.message })
        }

        this.chatAdmins = []
        await this.getAdmins(true)

        this.configurationMenu()
        this.listenMessages()

        // Fetch group name for logging
        try {
            const chat = await this.botApiProcessor.telegram.getChat(this.chatId)
            this.chatTitle = (chat as any).title || String(this.chatId)
        } catch (e) {
            this.chatTitle = String(this.chatId)
        }
        this.log(`Bot username: @${this.botUsername}`)
        this.log(`Monitoring group: ${this.chatTitle} (ID: ${this.chatId})`)

        this.log("Starting Telegram polling...")
        // Explicitly request all update types we need — without this Telegram may use
        // a cached filter from a previous session that excludes service messages like new_chat_members
        this.botApiProcessor.launch({
            allowedUpdates: [
                'message',
                'edited_message',
                'callback_query',
                'chat_member'
            ]
        })
        this.log("Starting Telegram polling... Done.")

        // Refresh admin list every hour
        setInterval(async () => {
            try {
                await this.getAdmins(false)
            } catch (e) {
                this.log("Admin refresh failed", { message: e.message })
            }
        }, 24 * 60 * 60 * 1000) // once per day

        // Recent join scan — disabled because group has "Hide Members" enabled,
        // which prevents Telegram from sending new_chat_members events to bots.
        // Re-enable if "Hide Members" is ever turned off.
        // setInterval(() => {
        //     this.recentJoinScan()
        // }, 60 * 1000)

        // One-time startup scan removed — DB now contains full member list (6k+ members)
        // Impersonation checks happen on join and on every message instead

        // On errors that reach our handler (middleware errors etc.), just log them
        this.botApiProcessor.catch((err) => {
            this.log("Unhandled error", err)
        })
    }

    private buildAdminSet() {
        this.adminSet = new Map()

        const lines: string[] = []
        const timestamp = new Date().toLocaleString('el-GR', {
            timeZone: 'Europe/Athens',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hourCycle: 'h23'
        })
        lines.push(`Admin list loaded at ${timestamp}`)
        lines.push(`${'='.repeat(60)}`)

        for (const admin of this.chatAdmins) {
            const first = this.normalize(admin.firstName)
            const last = this.normalize(admin.lastName)
            const username = this.normalize(admin.userName)
            const full = first + last

            if (full) {
                if (!this.adminSet.has(full)) this.adminSet.set(full, new Set())
                this.adminSet.get(full).add(admin.id)
            }

            lines.push(`ID:         ${admin.id}`)
            lines.push(`First Name: ${admin.firstName}`)
            lines.push(`Last Name:  ${admin.lastName || '(none)'}`)
            lines.push(`Username:   ${admin.userName || '(none)'}`)
            lines.push(`Normalized: first="${first}" last="${last}" username="${username}"`)
            lines.push(`Match key:  "${full}"`)
            lines.push(`${'-'.repeat(60)}`)
        }

        lines.push(`Total admins: ${this.chatAdmins.length}`)
        lines.push(`AdminSet size: ${this.adminSet.size}`)
        lines.push('')

        const logPath = 'adminlist.log'
        fs.writeFile(logPath, lines.join('\n'), (err) => {
            if (err) this.log("Failed to write adminlist.log", { message: err.message })
            else this.log("Admin list written to adminlist.log")
        })

        this.log(`AdminSet built... Size: ${this.adminSet.size}`)
    }

    private log(message: string, data?: any) {
        const timestamp = new Date().toLocaleString('el-GR', {
            timeZone: 'Europe/Athens',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hourCycle: 'h23'
        })
        if (data !== undefined) {
            console.log(`[${timestamp}] ${message}`, data)
        } else {
            console.log(`[${timestamp}] ${message}`)
        }
    }

    private isAdminMessage(memberId) {
        return this.chatAdmins.some(admin => admin.id == memberId)
    }

    private logAdminMessage(memberId, chatId) {
        const admin = this.chatAdmins.find(a => a.id == memberId)
        const name = admin ? `${admin.firstName}${admin.lastName ? ' ' + admin.lastName : ''}` : `ID:${memberId}`
        const chat = chatId == this.chatId
            ? `${this.chatTitle} (ID: ${chatId})`
            : `Config (Private)`
        this.log(`Admin message detected. Name: ${name} (ID: ${memberId}) - Chat: ${chat}`)
    }

    private adminName(memberId): string {
        const admin = this.chatAdmins.find(a => a.id == memberId)
        if (!admin) return String(memberId)
        const name = `${admin.firstName}${admin.lastName ? ' ' + admin.lastName : ''}`
        return `${name} (ID: ${memberId})`
    }

    private buildImpersonatorReport(records: any[]): string {
        if (!records || records.length === 0) return '[ No banned impersonators on record yet. ]'

        const lines = ['=== Last 10 banned impersonators ===']
        records.forEach((r, i) => {
            const identifier = r.chatMemberUserName ? `@${r.chatMemberUserName}` : `(no username)`
            // banDate can be a Unix timestamp (number), a date string, or zero/null
            let date = 'unknown date'
            if (r.banDate) {
                const ts = typeof r.banDate === 'number' ? r.banDate * 1000 : Date.parse(r.banDate)
                if (!isNaN(ts) && ts > 0) {
                    date = new Date(ts).toLocaleString('el-GR', {
                        timeZone: 'Europe/Athens',
                        day: 'numeric', month: 'numeric', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
                    })
                }
            }
            const impersonated = r.reason.replace('Banned for impersonating ', '')
            lines.push(`${i + 1}. ${identifier} - ID: ${r.chatMemberId}\nBanned on ${date} for impersonating ${impersonated}`)
        })
        return lines.join('\n')
    }

    private processMessage(message, ctx) {
        this.botMessage.displayMessage(`Received message: ${JSON.stringify(message, null, 2)}`)

        this.memberExists(message)

        let adminMessage = this.isAdminMessage(message.from.id)
        if (adminMessage) this.logAdminMessage(message.from.id, message.chat.id)

        // Check message sender for impersonation (non-admins only)
        if (!adminMessage) {
            this.checkMember({
                chatId: message.chat.id,
                chatMemberId: message.from.id,
                chatMemberFirstName: message.from.first_name,
                chatMemberLastName: message.from.last_name || '',
                chatMemberUserName: message.from.username || '',
                isBot: message.from.is_bot,
                messageId: message.message_id
            })
        }

        let messageToCheck = message.text ? message.text.replace(this.botConfigurator.getConfiguration().validChars, "") : ''

        if (!adminMessage) {
            let banMember = false
            let reason = ''
            let messageType = ''
            let messageToSend = ''
            let warningToSend = ''

            this.botMessage.displayMessage(`Check message: ${messageToCheck}`)

            if (this.botConfigurator.getConfiguration().rules.checkWalletKey.validate) {
                this.botConfigurator.getConfiguration().walletAddress.forEach(address => {
                    let pattern = new RegExp(address, "gi")
                    if (pattern.test(messageToCheck)) {
                        this.botMessage.displayMessage(`Wallet address detected: ${messageToCheck}`)

                        if (this.botConfigurator.getConfiguration().rules.checkWalletKey.banUser != -1) {
                            banMember = true
                            messageType = "WalletKey"
                        }
                        if (this.botConfigurator.getConfiguration().rules.checkWalletKey.removeMessage) {
                            reason = 'Removed message for posting Wallet address'
                            messageToSend = this.botConfigurator.getConfiguration().replyMessages.walletKey
                        }
                    }
                })
            }

            if (this.botConfigurator.getConfiguration().rules.checkUrl.validate) {
                let messageEntitiesExist = message.entities ? true : false

                let pattern = new RegExp(this.botConfigurator.getConfiguration().urlRegex, "gi")
                let match = pattern.test(messageToCheck)

                if (messageEntitiesExist) {
                    message.entities.forEach(entity => {
                        if (entity.type == 'url') {
                            this.botMessage.displayMessage(`URL detected: ${messageToCheck}`)
                            if (this.botConfigurator.getConfiguration().rules.checkUrl.banUser != -1) {
                                banMember = true
                                messageType = "Url"
                            }
                            if (this.botConfigurator.getConfiguration().rules.checkUrl.removeMessage) {
                                messageToSend = this.botConfigurator.getConfiguration().replyMessages.url
                            }
                        }
                    })
                } else if (match){
                    this.botMessage.displayMessage(`URL detected: ${messageToCheck}`)
                    if (this.botConfigurator.getConfiguration().rules.checkUrl.banUser != -1) {
                        banMember = true
                        messageType = "Url"
                    }
                    if (this.botConfigurator.getConfiguration().rules.checkUrl.removeMessage) {
                        messageToSend = this.botConfigurator.getConfiguration().replyMessages.url
                    }
                }
            }

            if (this.botConfigurator.getConfiguration().rules.checkBadWord.validate) {
                let regexRule = this.botConfigurator.getConfiguration().badWords
                let pattern = new RegExp(regexRule, "gi")
                let match = pattern.test(messageToCheck)

                if (match === true) {
                    this.botMessage.displayMessage(`${messageToCheck}  matches ${regexRule}`)

                    reason = 'Removed message for posting inappropriate content (bad language)'
                    if (this.botConfigurator.getConfiguration().rules.checkBadWord.banUser != -1) {
                        banMember = true
                        messageType = "BadWord"
                    }
                    if (this.botConfigurator.getConfiguration().rules.checkBadWord.removeMessage) {
                        messageToSend = this.botConfigurator.getConfiguration().replyMessages.inappropriateContent
                    }
                }
            }

            if (this.botConfigurator.getConfiguration().rules.checkVideo.validate || this.botConfigurator.getConfiguration().rules.checkAudio.validate || this.botConfigurator.getConfiguration().rules.checkImage.validate || this.botConfigurator.getConfiguration().rules.checkAnyFile.validate) {
                let documentExists = (message.document) ? true : false

                if (documentExists === true) {
                    let documentType = message.document.mime_type.substring(0, 5)

                    if (documentType == 'image') {
                        if (this.botConfigurator.getConfiguration().rules.checkImage.banUser != -1) {
                            banMember = true
                            messageType = "Image"
                        }
                        if (this.botConfigurator.getConfiguration().rules.checkImage.removeMessage) {
                            messageToSend = this.botConfigurator.getConfiguration().replyMessages.image
                            warningToSend = this.botConfigurator.getConfiguration().replyMessages.warning
                        }
                    }
                    if (documentType == 'audio') {
                        if (this.botConfigurator.getConfiguration().rules.checkAudio.banUser != -1) {
                            banMember = true
                            messageType = "Audio"
                        }
                        if (this.botConfigurator.getConfiguration().rules.checkAudio.removeMessage) {
                            messageToSend = this.botConfigurator.getConfiguration().replyMessages.audio
                            warningToSend = this.botConfigurator.getConfiguration().replyMessages.warning
                        }
                    }
                    if (documentType == 'video') {
                        if (this.botConfigurator.getConfiguration().rules.checkVideo.banUser != -1) {
                            banMember = true
                            messageType = "Video"
                        }
                        if (this.botConfigurator.getConfiguration().rules.checkVideo.removeMessage) {
                            messageToSend = this.botConfigurator.getConfiguration().replyMessages.video
                            warningToSend = this.botConfigurator.getConfiguration().replyMessages.warning
                        }
                    }
                }
            }

            if (banMember || messageToSend !== '') {
                let banMemberData = {
                    chatId: message.chat.id,
                    chatMemberId: message.from.id,
                    chatMemberFirstName: message.from.first_name,
                    chatMemberLastName: message.from.last_name ? message.from.last_name : '',
                    isBot: message.from.is_bot,
                    status: 'banned',
                    chatMemberUserName: message.from.username ? message.from.username : '',
                    reason: reason,
                    messageId: message.message_id
                }

                if (banMember) {
                    this.banOrWarnMember(banMemberData, messageType)
                }
                if (messageToSend !== '') {
                    warningToSend = this.botConfigurator.getConfiguration().replyMessages.warning
                    this.removeMessage(banMemberData, messageToSend, warningToSend)
                }
            }
        } else {
            if (message.chat.id != this.chatId && this.lastConfigRule != '') {
                let replyMessages = [
                    'inappropriateContentReplyMessage',
                    'walletKeyReplyMessage',
                    'urlReplyMessage',
                    'imageReplyMessage',
                    'audioReplyMessage',
                    'videoReplyMessage',
                    'warningReplyMessage'
                ]

                if (this.lastConfigRule == "badWordsSet") {
                    this.botConfigurator.processBadWords("set", message.text)

                    let ruleWords = this.botConfigurator.getConfiguration().badWords.toString().replace("(", "").replace(")", "").split("|").join(", ")
                    ctx.reply(`Banned Word/Phrase(s) are set to ${ruleWords}`)
                } else if (this.lastConfigRule == "badWordsUnset") {
                    this.botConfigurator.processBadWords("unset", message.text)

                    let ruleWords = this.botConfigurator.getConfiguration().badWords.toString().replace("(", "").replace(")", "").split("|").join(", ")
                    ctx.reply(`Banned Word/Phrase(s) are set to ${ruleWords}`)
                } else if (this.lastConfigRule == "nameBlacklistAdd") {
                    this.lastConfigRule = ''
                    const result = this.botConfigurator.processNameBlacklist('add', message.text)
                    ctx.reply(result)
                } else if (this.lastConfigRule == "nameBlacklistRemove") {
                    this.lastConfigRule = ''
                    const result = this.botConfigurator.processNameBlacklist('remove', message.text)
                    ctx.reply(result)
                } else if (this.lastConfigRule == "mmApiId") {
                    const apiId = parseInt(message.text.trim())
                    if (isNaN(apiId) || apiId <= 0) {
                        ctx.reply("Invalid API ID. It should be a number. Please try again:")
                    } else {
                        const fs = require('fs')
                        const configPath = require('path').join(__dirname, '../../telethon_config.json')
                        let cfg: any = {}
                        try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch (e) {}
                        cfg.api_id = apiId
                        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2))
                        this.lastConfigRule = 'mmApiHash'
                        ctx.reply("API ID saved. Now enter your Telethon API HASH (the hex string from my.telegram.org):")
                    }
                } else if (this.lastConfigRule == "mmApiHash") {
                    const apiHash = message.text.trim()
                    if (!apiHash || apiHash.length < 10) {
                        ctx.reply("Invalid API HASH. Please try again:")
                    } else {
                        const fs = require('fs')
                        const configPath = require('path').join(__dirname, '../../telethon_config.json')
                        let cfg: any = {}
                        try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch (e) {}
                        cfg.api_hash = apiHash
                        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2))
                        this.lastConfigRule = ''
                        ctx.reply("Telethon API credentials saved. You can now use the Member Management features.")
                        this.log(`Admin ${this.adminName(message.from.id)} configured Telethon API credentials`)
                    }
                } else if (replyMessages.indexOf(this.lastConfigRule) != -1) {
                    this.botConfigurator.processReplyMessage(this.lastConfigRule, message.text)

                    ctx.reply("New Reply Message is set")
                } else {
                    if (this.botConfigurator.processBanUserRule(this.lastConfigRule, message.text)) {
                        this.lastConfigRule = ''
                        ctx.reply(`Ban User Settings Warning is set to ${message.text}`)
                    } else {
                        ctx.reply("Invalid value for Ban User Settings Warning")
                    }
                }
            }
        }
    }

    private processMultimediaMessage(message, messageType) {
        this.memberExists(message)

        let adminMessage = this.isAdminMessage(message.from.id)

        if (!adminMessage) {
            // Check sender for impersonation
            this.checkMember({
                chatId: message.chat.id,
                chatMemberId: message.from.id,
                chatMemberFirstName: message.from.first_name,
                chatMemberLastName: message.from.last_name || '',
                chatMemberUserName: message.from.username || '',
                isBot: message.from.is_bot,
                messageId: message.message_id
            })

            let banMember = false
            let messageToSend = ''
            let reason = ''

            if (messageType == 'Audio') {
                if (this.botConfigurator.getConfiguration().rules.checkAudio.banUser != -1) {
                    banMember = true
                }
                if (this.botConfigurator.getConfiguration().rules.checkAudio.removeMessage) {
                    reason = 'Banned for posting inappropriate content (audio)'
                    messageToSend = this.botConfigurator.getConfiguration().replyMessages.audio
                }
            } else if (messageType == 'Video') {
                if (this.botConfigurator.getConfiguration().rules.checkVideo.banUser != -1) {
                    banMember = true
                }
                if (this.botConfigurator.getConfiguration().rules.checkVideo.removeMessage) {
                    reason = 'Banned for posting inappropriate content (video)'
                    messageToSend = this.botConfigurator.getConfiguration().replyMessages.video
                }
            } else if (messageType == 'Image') {
                if (this.botConfigurator.getConfiguration().rules.checkImage.banUser != -1) {
                    banMember = true
                }
                if (this.botConfigurator.getConfiguration().rules.checkImage.removeMessage) {
                    reason = 'Banned for posting inappropriate content (image)'
                    messageToSend = this.botConfigurator.getConfiguration().replyMessages.image
                }
            }

            if (banMember || messageToSend) {
                let warningToSend = this.botConfigurator.getConfiguration().replyMessages.warning

                let banMemberData = {
                    chatId: message.chat.id,
                    chatMemberId: message.from.id,
                    chatMemberFirstName: message.from.first_name,
                    chatMemberLastName: message.from.last_name ? message.from.last_name : '',
                    isBot: message.from.is_bot,
                    status: 'banned',
                    chatMemberUserName: message.from.username ? message.from.username : '',
                    reason: reason,
                    messageId: message.message_id
                }

                if (banMember) {
                    this.banOrWarnMember(banMemberData, messageType)
                }

                if (messageToSend) {
                    this.removeMessage(banMemberData, messageToSend, warningToSend)
                }
            }
        } else {
            this.botMessage.displayMessage(`Message from Admin to be skipped: ${message.text}`)
        }
    }

    private memberExists(message) {
        message.new_chat_member = message.from
        message.new_chat_member.date = message.date;
        message.new_chat_member.isRealJoin = false  // flag: this is a message, not an actual join event

        this.addMember(message);
    }

    private addMember(message) {
        this.botMessage.displayMessage(`New member: ${JSON.stringify(message, null, 2)}`)

        // If they can post/join, Telegram has already confirmed they're not banned.
        // We skip the re-ban check — if a human admin unbanned someone the bot previously
        // banned, we respect that decision and let them through.
        const isRealJoin = message.isRealJoin === true

        // Check if member already exists in DB
        this.dbConnection.getRepository(ChatMember).findOne({ chatMemberId: message.new_chat_member.id }).then(existing => {
            if (existing) {
                // Member already in DB — only check for impersonation on real joins, don't overwrite joinDate
                if (isRealJoin && !this.chatAdmins.some(admin => admin.id == message.new_chat_member.id)) {
                    this.checkMember(existing)
                }
                return
            }

            // New member — insert with real joinDate
            let newChatMember = new ChatMember()
            newChatMember.chatId = message.chat.id
            newChatMember.chatMemberId = message.new_chat_member.id
            newChatMember.chatMemberFirstName = message.new_chat_member.first_name
            newChatMember.chatMemberLastName = (message.new_chat_member.last_name) ? message.new_chat_member.last_name : ''
            newChatMember.chatMemberUserName = (message.new_chat_member.username) ? message.new_chat_member.username : ''
            newChatMember.isBot = message.new_chat_member.is_bot
            newChatMember.isAdmin = (message.new_chat_member.is_admin) ? message.new_chat_member.is_admin : false
            newChatMember.joinDate = message.new_chat_member.date
            newChatMember.status = 'active'
            newChatMember.warning = 0

            if (isRealJoin) {
                const firstName = message.new_chat_member.first_name || ''
                const lastName = message.new_chat_member.last_name ? ' ' + message.new_chat_member.last_name : ''
                const username = message.new_chat_member.username ? ` (@${message.new_chat_member.username})` : ''
                this.log(`New member joined: ${firstName}${lastName}${username} (ID: ${message.new_chat_member.id}) — added to DB, impersonation scan triggered`)
                this.recentJoiners.set(message.new_chat_member.id, Date.now())
            } else {
                const firstName = message.new_chat_member.first_name || ''
                const username = message.new_chat_member.username ? ` (@${message.new_chat_member.username})` : ''
                this.log(`New member first seen: ${firstName}${username} (ID: ${message.new_chat_member.id}) — added to DB`)
            }

            this.dbConnection.getRepository(ChatMember).save(newChatMember)

            const memberData = {
                chatId: message.chat.id,
                chatMemberId: message.new_chat_member.id,
                chatMemberFirstName: message.new_chat_member.first_name,
                chatMemberLastName: (message.new_chat_member.last_name) ? message.new_chat_member.last_name : '',
                isBot: message.new_chat_member.is_bot,
                joinDate: message.new_chat_member.date,
                status: 'active',
                chatMemberUserName: (message.new_chat_member.username) ? message.new_chat_member.username : '',
                isAdmin: (message.new_chat_member.is_admin) ? message.new_chat_member.is_admin : false,
                reason: 'Joined chat group'
            }

            this.addMemberHistory(memberData)

            // Check new member for impersonation immediately (skip if admin)
            if (!this.chatAdmins.some(admin => admin.id == message.new_chat_member.id)) {
                this.checkMember(newChatMember)
            }
        }).catch((e) => {
            this.log("Telegram API ERROR (addMember)", { message: e.message, code: e.code })
        })
    }

    private addMemberHistory(message) {
        let newMemberHistory = new MemberHistory();
        newMemberHistory.chatId = message.chatId;
        newMemberHistory.chatMemberId = message.chatMemberId;
        newMemberHistory.chatMemberFirstName = message.chatMemberFirstName;
        newMemberHistory.chatMemberLastName= message.chatMemberLastName;
        newMemberHistory.chatMemberUserName= message.chatMemberUserName;
        newMemberHistory.isBot = message.isBot;
        newMemberHistory.joinDate = message.joinDate;
        newMemberHistory.status = message.status;
        newMemberHistory.isAdmin = message.isAdmin;
        newMemberHistory.reason = message.reason;
        if (message.status === 'banned') {
            newMemberHistory.banDate = Math.floor(Date.now() / 1000)
        }

        this.dbConnection.getRepository(MemberHistory).save(newMemberHistory);

    }

    private removeMember(message) {
		this.botMessage.displayMessage(`Remove chat member
                     ${message.left_chat_member.id},
                     ${message.left_chat_member.first_name}
                     ${((message.left_chat_member.last_name) ? message.left_chat_member.last_name : '')}`)

        this.dbConnection.getRepository(ChatMember).removeById(message.left_chat_member.id)

        let memberData = {
            chatId: message.chat.id,
            chatMemberId: message.left_chat_member.id,
            chatMemberFirstName: message.left_chat_member.first_name,
            chatMemberLastName: (message.left_chat_member.last_name) ? message.left_chat_member.last_name : '',
            isBot: message.left_chat_member.is_bot,
            joinDate: message.left_chat_member.date,
            status: 'inactive',
            chatMemberUserName: (message.left_chat_member.username) ? message.left_chat_member.username : '',
            isAdmin: (message.left_chat_member.is_admin) ? message.left_chat_member.is_admin : false,
            reason: 'Left chat group'
        }

        this.addMemberHistory(memberData)
    }

    // Returns the impersonated admin's display name if the member should be banned, null otherwise
    private userShouldBeBanned(member): string | null {
        if (!this.botConfigurator.getConfiguration().rules.checkAdmin.validate) {
            return null
        }

        const first = this.normalize(member.first_name)
        const last = this.normalize(member.last_name)

        const full = first + last
        if (full && this.adminSet.has(full)) {
            const matchedAdminIds = this.adminSet.get(full)
            const stillExistingAdmin = this.chatAdmins.find(a =>
                [...matchedAdminIds].includes(a.id)
            )
            if (!stillExistingAdmin) {
                this.log("Name match found but admin no longer exists — skipping ban", { normalized: full })
                return null
            }
            if (matchedAdminIds.has(member.id)) {
                return null
            }
            const adminDisplayName = stillExistingAdmin.firstName +
                (stillExistingAdmin.lastName ? ' ' + stillExistingAdmin.lastName : '')
            return adminDisplayName
        }

        return null
    }

    private checkMember(member) {
        // Prevent duplicate simultaneous checks for the same member
        if (this.checkingMembers.has(member.chatMemberId)) return
        this.checkingMembers.add(member.chatMemberId)

        this.botApiProcessor.telegram.getChat(member.chatMemberId).then(async details => {

            // Skip if this user is a known admin
            if (this.chatAdmins.some(admin => admin.id == details.id)) {
                this.checkingMembers.delete(member.chatMemberId)
                return
            }

            this.botMessage.displayMessage(`Check member: ${member.chatMemberId}, ${member.chatMemberFirstName} ${member.chatMemberLastName} ${member.chatMemberUserName}`)

            const impersonatedAdmin = this.userShouldBeBanned(details)
            if (impersonatedAdmin !== null &&
                this.botConfigurator.getConfiguration().rules.checkAdmin.banUser == 0) {

                const impersonatorName = details.first_name +
                    (details.last_name ? ' ' + details.last_name : '') +
                    (details.username ? ' (@' + details.username + ')' : '')

                this.log(`IMPERSONATOR DETECTED — "${impersonatorName}" impersonating admin "${impersonatedAdmin}" — banning and deleting message`)

                let banMemberData = {
                    chatId: member.chatId,
                    chatMemberId: member.chatMemberId,
                    chatMemberFirstName: details.first_name,
                    chatMemberLastName: details.last_name ? details.last_name : '',
                    isBot: member.isBot,
                    status: 'banned',
                    chatMemberUserName: details.username ? details.username : '',
                    reason: `Banned for impersonating ${impersonatedAdmin}`
                }

                // Delete the impersonator's message
                if (member.messageId) {
                    this.botApiProcessor.telegram.deleteMessage(this.chatId, member.messageId)
                        .then(() => this.log(`Impersonator message deleted successfully (ID: ${member.messageId})`))
                        .catch((e) => {
                            // Silently ignore "message not found" — already deleted manually
                            if (!e.message.includes('message to delete not found')) {
                                this.log("Could not delete impersonator message", { message: e.message })
                            }
                        })
                }

                // Send group notification
                const groupMsg = `User ${details.username ? '@' + details.username : member.chatMemberId} impersonating admin "${impersonatedAdmin}" removed from group.`
                this.botApiProcessor.telegram.sendMessage(this.chatId, groupMsg)
                    .catch((e) => this.log("Could not send impersonator notice", { message: e.message }))

                this.banOrWarnMember(banMemberData, 'Admin')
            }

            // Check name against blacklist (only if not already caught as impersonator)
            if (impersonatedAdmin === null) {
                const matchedKeyword = this.nameMatchesBlacklist(details)
                if (matchedKeyword !== null) {
                    const displayName = details.first_name +
                        (details.last_name ? ' ' + details.last_name : '') +
                        (details.username ? ' (@' + details.username + ')' : '')
                    await this.muteMember(details.id, this.chatId, displayName, member.messageId, matchedKeyword)
                }
            }

            this.checkingMembers.delete(member.chatMemberId)

        }).catch((e) => {
            this.checkingMembers.delete(member.chatMemberId)
            // "chat not found" = deleted/deactivated Telegram account, nothing to act on
            if (!e.message.includes('chat not found')) {
                this.log("ERROR in getChat", { message: e.message, code: e.code })
            }
        })
    }

    // Returns the matched blacklist keyword if the member's name contains a blacklisted word, null otherwise
    private nameMatchesBlacklist(details: any): string | null {
        const blacklist: string[] = Array.isArray((this.botConfigurator.getConfiguration() as any).nameBlacklist)
            ? (this.botConfigurator.getConfiguration() as any).nameBlacklist
            : []
        if (blacklist.length === 0) return null

        const first = this.normalize(details.first_name)
        const last = this.normalize(details.last_name)
        const username = this.normalize(details.username)
        const fullName = first + (last ? last : '')

        for (const keyword of blacklist) {
            const normalizedKeyword = this.normalize(keyword)
            if (!normalizedKeyword) continue
            if (fullName.includes(normalizedKeyword) || username.includes(normalizedKeyword)) {
                return keyword
            }
        }
        return null
    }

    private async muteMember(memberId: number, chatId: number, displayName: string, messageId: number | undefined, matchedKeyword: string) {
        // Mute: remove all send permissions indefinitely
        try {
            await this.botApiProcessor.telegram.restrictChatMember(chatId, memberId, {
                permissions: {
                    can_send_messages: false,
                    can_send_audios: false,
                    can_send_documents: false,
                    can_send_photos: false,
                    can_send_videos: false,
                    can_send_video_notes: false,
                    can_send_voice_notes: false,
                    can_send_polls: false,
                    can_send_other_messages: false,
                    can_add_web_page_previews: false
                }
            })
            this.log(`BLACKLISTED NAME — "${displayName}" muted for matching keyword "${matchedKeyword}"`)
        } catch (e) {
            this.log(`Could not mute member ${memberId}`, { message: e.message })
        }

        // Delete the triggering message if present
        if (messageId) {
            this.botApiProcessor.telegram.deleteMessage(chatId, messageId)
                .then(() => this.log(`Blacklisted name message deleted (ID: ${messageId})`))
                .catch((e) => {
                    if (!e.message.includes('message to delete not found')) {
                        this.log("Could not delete blacklisted name message", { message: e.message })
                    }
                })
        }

        // Alert in the group chat
        const alertMsg = `⚠️ Potential scammer alert! "${displayName}" muted for using a blacklisted name.`
        this.botApiProcessor.telegram.sendMessage(chatId, alertMsg)
            .catch((e) => this.log("Could not send blacklist mute alert", { message: e.message }))
    }


    // Skips members already marked as banned in the DB
    private startupMemberScan() {
        if (!this.botConfigurator.getConfiguration().rules.checkAdmin.validate) {
            return
        }

        if (!this.dbConnection) {
            this.log("startupMemberScan: no DB connection, skipping")
            return
        }

        this.log("Starting one-time startup member scan...")

        this.dbConnection.getRepository(ChatMember).find().then(members => {
            const adminIds = new Set(this.chatAdmins.map(a => a.id))
            const active = members.filter(m => m.status !== 'banned' && !adminIds.has(m.chatMemberId))
            this.log(`Startup scan: ${active.length} active non-admin members to check`)

            active.forEach((member, index) => {
                setTimeout(() => {
                    this.checkMember(member)
                    // Log completion after the last member is checked
                    if (index === active.length - 1) {
                        this.log("Startup scan... Done.")
                    }
                }, index * 50)
            })
        }).catch((e) => {
            this.log("startupMemberScan error", { message: e.message })
        })
    }

    // Scans members who joined in the last 10 minutes — runs every 1 minute.
    // Catches impersonators who join clean then rename to match an admin before posting.
    // DISABLED: group has "Hide Members" enabled, so new_chat_members events are never fired.
    // Re-enable the setInterval call in start() and this method if "Hide Members" is turned off.
    //
    // private recentJoinScan() {
    //     if (!this.botConfigurator.getConfiguration().rules.checkAdmin.validate) return
    //
    //     const tenMinutesAgo = Date.now() - 10 * 60 * 1000
    //     const adminIds = new Set(this.chatAdmins.map(a => a.id))
    //
    //     // Remove entries older than 10 minutes
    //     for (const [id, joinedAt] of this.recentJoiners) {
    //         if (joinedAt < tenMinutesAgo) this.recentJoiners.delete(id)
    //     }
    //
    //     const toCheck = [...this.recentJoiners.keys()].filter(id => !adminIds.has(id))
    //
    //     if (toCheck.length > 0) {
    //         this.log(`Recent join scan: checking ${toCheck.length} member(s) who joined in the last 10 minutes`)
    //         toCheck.forEach(id => this.checkMember({ chatMemberId: id, chatId: this.chatId }))
    //     }
    // }

    private removeMessage(message, messageToSend, warningToSend) {
        this.botMessage.displayMessage(`Delete message ${message.messageId}`)

        this.botApiProcessor.telegram.deleteMessage(this.botConfigurator.getConfiguration().chatId, message.messageId).then(details => {
            this.botMessage.displayMessage(JSON.stringify(details, null, 2))

            let memberIdentifier = '@' + message.chatMemberFirstName + ' ' + message.chatMemberLastName + (message.chatMemberUserName ? ('(' + message.chatMemberUserName + ')') : '')

            if (messageToSend !== '') {
                this.botMessage.displayMessage(`Send message ${memberIdentifier}, ${messageToSend}`)

                this.botApiProcessor.telegram.sendMessage(this.botConfigurator.getConfiguration().chatId, memberIdentifier + ', ' + messageToSend).then(details => {
                    this.botMessage.displayMessage(JSON.stringify(details, null, 2))
                }).catch((e) => {
                    this.log("Telegram API ERROR (sendMessage)", { message: e.message, code: e.code })
                })
            }

            if (warningToSend !== '') {
                this.botMessage.displayMessage(`Send message ${memberIdentifier}, ${warningToSend}`)
                this.botApiProcessor.telegram.sendMessage(this.botConfigurator.getConfiguration().chatId, memberIdentifier + ', ' + warningToSend).then(details => {
                    this.botMessage.displayMessage(JSON.stringify(details, null, 2))
                }).catch((e) => {
                    this.log("Telegram API ERROR (sendMessage)", { message: e.message, code: e.code })
                })
            }

        }).catch((e) => {
            if (!e.message.includes('message to delete not found')) {
                this.log("Telegram API ERROR (deleteMessage)", { message: e.message, code: e.code })
            }
        })
}

    private banOrWarnMember(member, messageType) {
        this.dbConnection.getRepository(ChatMember).findOneById(member.chatMemberId).then(memberDetails => {

            if (memberDetails) {
                let banImmediately = -1
                let allowedValue = 0

                switch (messageType) {
                    case "Admin":
                        banImmediately = 0
                        allowedValue = 0
                        memberDetails.warning++
                        break
                    case "WalletKey":
                        banImmediately = memberDetails.warningWalletKey
                        allowedValue = this.botConfigurator.getConfiguration().rules.checkWalletKey.banUser
                        memberDetails.warningWalletKey++
                        break
                    case "BadWord":
                        banImmediately = memberDetails.warningBadWord
                        allowedValue = this.botConfigurator.getConfiguration().rules.checkBadWord.banUser
                        memberDetails.warningBadWord++
                        break
                    case "Audio":
                        banImmediately = memberDetails.warningAudio
                        allowedValue = this.botConfigurator.getConfiguration().rules.checkAudio.banUser
                        memberDetails.warningAudio++
                        break
                    case "Video":
                        banImmediately = memberDetails.warningVideo
                        allowedValue = this.botConfigurator.getConfiguration().rules.checkVideo.banUser
                        memberDetails.warningVideo++
                        break
                    case "Image":
                        banImmediately = memberDetails.warningImage
                        allowedValue = this.botConfigurator.getConfiguration().rules.checkImage.banUser
                        memberDetails.warningImage++
                        break
                    case "AnyFile":
                        banImmediately = memberDetails.warningAnyFile
                        allowedValue = this.botConfigurator.getConfiguration().rules.checkAnyFile.banUser
                        memberDetails.warningAnyFile++
                        break
                    case "Url":
                        banImmediately = memberDetails.warningUrl
                        allowedValue = this.botConfigurator.getConfiguration().rules.checkUrl.banUser
                        memberDetails.warningUrl++
                        break
                }

                if (banImmediately == -1 || banImmediately < allowedValue) {
                    this.botMessage.displayMessage("Warn member for displaying inappropriate content")
                    this.dbConnection.getRepository(ChatMember).save(memberDetails);
                } else {
                    this.botMessage.displayMessage("Ban member from group.")
                    this.botApiProcessor.telegram.banChatMember(this.botConfigurator.getConfiguration().chatId, member.chatMemberId, 0).then(details => {
                        this.log(`Member ${member.chatMemberId} banned successfully.`)

                        this.dbConnection.getRepository(ChatMember).removeById(member.chatMemberId);

                        let memberData = {
                            chatId: member.chatId,
                            chatMemberId: member.chatMemberId,
                            chatMemberFirstName: member.chatMemberFirstName,
                            chatMemberLastName: member.chatMemberLastName ? member.chatMemberLastName : '',
                            isBot: member.isBot,
                            joinDate: memberDetails.joinDate,
                            status: 'banned',
                            chatMemberUserName: member.chatMemberUserName ? member.chatMemberUserName : '',
                            isAdmin: memberDetails.isAdmin,
                            reason: member.reason || 'Banned for posting too many inappropriate messages'
                        }

                        this.addMemberHistory(memberData)
                    }).catch((e) => {
                        this.log("Telegram API ERROR (banChatMember)", { message: e.message, code: e.code })
                    })
                }
            }
        }).catch((e) => {
            this.log("Telegram API ERROR (banOrWarnMember)", { message: e.message, code: e.code })
        })
}

	private async getAdmins(display) {
		try {
			const adminsData = await this.botApiProcessor.telegram.getChatAdministrators(
				this.botConfigurator.getConfiguration().chatId
			)

			this.chatAdmins = adminsData.map(admin => ({
				id: admin.user.id,
				firstName: admin.user.first_name || '',
				lastName: admin.user.last_name || '',
				userName: admin.user.username || ''
			}))

			this.buildAdminSet()

			this.log(`Admins loaded... Count: ${this.chatAdmins.length}`)

			if (display) {
				this.botMessage.displayMessage("Current Admins")
				this.botMessage.displayMessage(JSON.stringify(this.chatAdmins, null, 2))
			}

		} catch (e) {
			this.log("Error in getAdmins", {
				message: e.message,
				code: e.code
			})
		}
	}

    private listenMessages() {

        if (this.handlersInitialized) {
            this.log("Handlers already registered, skipping.")
            return
        }
        this.handlersInitialized = true

        this.log("Registering handlers once...")
        this.botApiProcessor.on('new_chat_members', (ctx) => {
            // Mark as a real join event so addMember stores the correct joinDate
            ctx.message.isRealJoin = true
            const members = ctx.message.new_chat_members || [ctx.message.new_chat_member]
            members.forEach(m => {
                if (m) this.log(`Join event received: ${m.first_name || ''}${m.username ? ' (@' + m.username + ')' : ''} (ID: ${m.id})`)
            })
            this.addMember(ctx.message)
        })
        this.botApiProcessor.on('left_chat_member', (ctx) => this.removeMember(ctx.message))

        // chat_member update — fires on join, leave, ban, and NAME CHANGES
        // even with "Hide Members" enabled. This catches impersonators who join
        // clean then rename to match an admin.
        this.botApiProcessor.on('chat_member', (ctx) => {
            const update = ctx.chatMember
            const newMember = update.new_chat_member
            const oldMember = update.old_chat_member

            // Only process if the user is currently a member (not left/banned/restricted)
            if (newMember.status !== 'member' && newMember.status !== 'creator' && newMember.status !== 'administrator') {
                return
            }

            // Skip admins
            if (this.isAdminMessage(newMember.user.id)) return

            const user = newMember.user
            const displayName = user.first_name +
                (user.last_name ? ' ' + user.last_name : '') +
                (user.username ? ' (@' + user.username + ')' : '')

            // Detect name change — old and new status are both 'member' but name differs
            const nameChanged = oldMember.status === 'member' &&
                (oldMember.user.first_name !== user.first_name || oldMember.user.last_name !== user.last_name)

            if (nameChanged) {
                this.log(`Name change detected: "${oldMember.user.first_name}${oldMember.user.last_name ? ' ' + oldMember.user.last_name : ''}" → "${user.first_name}${user.last_name ? ' ' + user.last_name : ''}" (ID: ${user.id})`)
            }

            // Run impersonation + blacklist check
            this.checkMember({
                chatId: update.chat.id,
                chatMemberId: user.id,
                chatMemberFirstName: user.first_name,
                chatMemberLastName: user.last_name || '',
                chatMemberUserName: user.username || '',
                isBot: user.is_bot,
                messageId: undefined  // no message to delete on name change
            })
        })

        if (this.botConfigurator.getConfiguration().rules.checkImage.validate) {
            this.botApiProcessor.on('photo', (ctx) => this.processMultimediaMessage(ctx.message, 'Image'))
        }
        if (this.botConfigurator.getConfiguration().rules.checkVideo.validate) {
            this.botApiProcessor.on('video', (ctx) => this.processMultimediaMessage(ctx.message, 'Video'))
            this.botApiProcessor.on('video_note', (ctx) => this.processMultimediaMessage(ctx.message, 'Video'))
        }
        if (this.botConfigurator.getConfiguration().rules.checkAudio.validate) {
            this.botApiProcessor.on('voice', (ctx) => this.processMultimediaMessage(ctx.message, 'Audio'))
            this.botApiProcessor.on('audio', (ctx) => this.processMultimediaMessage(ctx.message, 'Audio'))
        }

        // Always register the message handler — memberExists() and impersonation checks
        // must run on every message regardless of which content rules are enabled
        this.botApiProcessor.on('message', (ctx) => this.processMessage(ctx.message, ctx))

        this.log("Registering handlers once... Done.")
    }

    private configurationMenu() {
        let checkRules = [
            {'type': 'checkAdmin', 'title': 'Fake Admin Phishing'},
            {'type': 'checkWalletKey', 'title': 'Check Message for Wallet/Key'},
            {'type': 'checkBadWord', 'title': 'Check Message for Banned Words'},
            {'type': 'checkUrl', 'title': 'Check Message for URLs'},
            {'type': 'checkImage', 'title': 'Check Message for Image'},
            {'type': 'checkAudio', 'title': 'Check Message for Audio'},
            {'type': 'checkVideo', 'title': 'Check Message for Video'}
        ]

        let replyMessages = [
            {'type': 'inappropriateContentReplyMessage', 'title': 'Inappropriate Content'},
            {'type': 'walletKeyReplyMessage', 'title': 'Wallet Address / Private Key'},
            {'type': 'urlReplyMessage', 'title': 'Posting URL'},
            {'type': 'imageReplyMessage', 'title': 'Posting Image'},
            {'type': 'audioReplyMessage', 'title': 'Posting Audio'},
            {'type': 'videoReplyMessage', 'title': 'Posting Video'},
            {'type': 'warningReplyMessage', 'title': 'Warning the Member'}
        ]

        let checkAdminRuleValidate
        let checkAdminRuleBanUser

        let menus = []

        let configurationMenu = Markup.inlineKeyboard([
                    [
                        Markup.button.callback('Fake Admin Phishing', 'checkAdmin'),
                        Markup.button.callback('Check for Wallet/Key', 'checkWalletKey')
                    ],
                    [
                        Markup.button.callback('Check for Banned Words', 'checkBadWord'),
                        Markup.button.callback('Check for URLs', 'checkUrl')
                    ],
                    [
                        Markup.button.callback('Check for Images', 'checkImage'),
                        Markup.button.callback('Check for Audio', 'checkAudio')
                    ],
                    [
                        Markup.button.callback('Check for Video', 'checkVideo'),
                        Markup.button.callback('Set Banned Words', 'badWords')
                    ],
                    [
                        Markup.button.callback('🚫 Blacklisted Names', 'nameBlacklist')
                    ],
                    [
                        Markup.button.callback('Set Reply Messages', 'replyMessages')
                    ],
                    [
                        Markup.button.callback('🧹 Clean Deleted Accounts', 'cleanDeleted')
                    ],
                    [
                        Markup.button.callback('📋 Last 10 Banned Impersonators', 'reportImpersonators')
                    ]
                ])

        this.botApiProcessor.hears(/menu/i, (ctx) => {
            if (this.isAdminMessage(ctx.message.from.id) && ctx.message.chat.id != this.chatId) {
                this.lastConfigRule = ''
                ctx.reply('Configuration Menu', configurationMenu)
            }
        });

        this.botApiProcessor.hears(/help/i, (ctx) => {
            if (this.isAdminMessage(ctx.message.from.id) && ctx.message.chat.id != this.chatId) {
                this.lastConfigRule = ''
                ctx.reply("https://zenchain.com/telegram-bot-guide/")
            }
        });

        // /report@botname — admin-only, replies publicly in the group with last 10 banned impersonators
        this.botApiProcessor.hears(new RegExp(`^/report(@${this.botUsername})?$`, 'i'), async (ctx) => {
            if (!this.isAdminMessage(ctx.message.from.id)) return
            if (ctx.message.chat.id !== this.chatId) return

            try {
                const records = await this.dbConnection
                    .getRepository('MemberHistory')
                    .createQueryBuilder('h')
                    .where("h.reason LIKE :reason", { reason: '%impersonat%' })
                    .orderBy('h.id', 'DESC')
                    .limit(10)
                    .getMany()

                const report = this.buildImpersonatorReport(records)
                ctx.reply(report)
                this.log(`Admin ${this.adminName(ctx.message.from.id)} requested impersonator report`)
                this.log(report)
            } catch (e) {
                this.log("Error fetching impersonator report", { message: e.message })
            }
        })

        this.botApiProcessor.action('mainMenu', (ctx) => {
            if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                ctx.reply('Configuration Menu', configurationMenu)
            }
        })

        this.botApiProcessor.action('reportImpersonators', async (ctx) => {
            if (!this.isAdminMessage(ctx.callbackQuery.from.id)) return

            try {
                const records = await this.dbConnection
                    .getRepository('MemberHistory')
                    .createQueryBuilder('h')
                    .where("h.reason LIKE :reason", { reason: '%impersonat%' })
                    .orderBy('h.id', 'DESC')
                    .limit(10)
                    .getMany()

                const report = this.buildImpersonatorReport(records)
                const backButton = Markup.inlineKeyboard([
                    [Markup.button.callback('Back to Main Menu', 'mainMenu')]
                ])
                ctx.reply(report, backButton)
                this.log(`Admin ${this.adminName(ctx.callbackQuery.from.id)} requested impersonator report via menu`)
                this.log(report)
            } catch (e) {
                this.log("Error fetching impersonator report", { message: e.message })
                ctx.reply('Error fetching report. Please try again.')
            }
        })

        checkRules.forEach(rule => {
            if (rule.type == 'checkAdmin') {
                menus[rule.type] = Markup.inlineKeyboard([
                                        [
                                            Markup.button.callback('Enable/Disable', `${rule.type}RuleValidate`),
                                            Markup.button.callback('Ban User', `${rule.type}RuleBanUser`)
                                        ],
                                        [
                                            Markup.button.callback('Back to Main Menu', 'mainMenu')
                                        ]
                                    ])
            } else {
                menus[rule.type] = Markup.inlineKeyboard([
                                        [
                                            Markup.button.callback('Enable/Disable', `${rule.type}RuleValidate`),
                                            Markup.button.callback('Ban User', `${rule.type}RuleBanUser`)
                                        ],
                                        [
                                            Markup.button.callback('Remove Message', `${rule.type}RuleRemoveMessage`),
                                            Markup.button.callback('Back to Main Menu', 'mainMenu')
                                        ]
                                    ])
            }
            this.botApiProcessor.action(`${rule.type}`, (ctx) => {
                if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                    this.lastConfigRule = ''
                    ctx.reply(rule.title, menus[rule.type])
                }
            })

            this.botApiProcessor.action(`${rule.type}RuleValidate`, (ctx) => {
                if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                    let currentStatus = ''
                    let newStatus = ''

                    if (this.botConfigurator.getConfiguration().rules[rule.type].validate) {
                        currentStatus = 'Enabled'
                        newStatus = 'Disable'
                    } else {
                        currentStatus = 'Disabled'
                        newStatus = 'Enable'
                    }

                    let validateMenu = Markup.inlineKeyboard([
                            [Markup.button.callback(`${newStatus}`, `${rule.type}RuleValidate${newStatus}`)],
                            [Markup.button.callback(`Back to ${rule.title} Menu`, `${rule.type}`)]
                        ]);

                    this.lastConfigRule = ''
                    ctx.reply(`Setting is ${currentStatus}`, validateMenu)
                }
            })

            this.botApiProcessor.action(`${rule.type}RuleValidateEnable`, (ctx) => {
                if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                    this.lastConfigRule = ''
                    if (this.botConfigurator.processValidationRule(rule.type, 'on')) {
                        ctx.reply("Setting is set to Enabled")
                    } else {
                        ctx.reply("Invalid value for Setting")
                    }
                }
            })

            this.botApiProcessor.action(`${rule.type}RuleValidateDisable`, (ctx) => {
                if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                    this.lastConfigRule = ''
                    if (this.botConfigurator.processValidationRule(rule.type, 'off')) {
                        ctx.reply("Setting is set to Disabled")
                    } else {
                        ctx.reply("Invalid value for Setting")
                    }
                }
            })


            this.botApiProcessor.action(`${rule.type}RuleRemoveMessage`, (ctx) => {
                if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                    let currentStatus = ''
                    let newStatus = ''

                    if (this.botConfigurator.getConfiguration().rules[rule.type].removeMessage) {
                        currentStatus = 'Enabled'
                        newStatus = 'Disable'
                    } else {
                        currentStatus = 'Disabled'
                        newStatus = 'Enable'
                    }

                    let removeMessageMenu = Markup.inlineKeyboard([
                            [Markup.button.callback(`${newStatus}`, `${rule.type}RuleRemoveMessage${newStatus}`)],
                            [Markup.button.callback(`Back to ${rule.title} Menu`, `${rule.type}`)]
                        ]);

                    this.lastConfigRule = ''
                    ctx.reply(`Remove Message Setting is ${currentStatus}`, removeMessageMenu)
                }
            })

            this.botApiProcessor.action(`${rule.type}RuleRemoveMessageEnable`, (ctx) => {
                if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                    this.lastConfigRule = ''
                    if (this.botConfigurator.processRemoveMessageRule(rule.type, 'on')) {
                        ctx.reply("Remove Message Setting is set to Enabled")
                    } else {
                        ctx.reply("Invalid value for Remove Message Setting")
                    }
                }
            })

            this.botApiProcessor.action(`${rule.type}RuleRemoveMessageDisable`, (ctx) => {
                if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                    this.lastConfigRule = ''
                    if (this.botConfigurator.processRemoveMessageRule(rule.type, 'off')) {
                        ctx.reply("Remove Message Setting is set to Disabled")
                    } else {
                        ctx.reply("Invalid value for Remove Message Setting")
                    }
                }
            })


            this.botApiProcessor.action(`${rule.type}RuleBanUser`, (ctx) => {
                if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                    this.lastConfigRule = ''
                    let banUserMenu
                    let currentStatus = ''
                    let warnings = this.botConfigurator.getConfiguration().rules[rule.type].banUser

                    if (warnings == 0) {
                        currentStatus = 'Ban Immediately'

                        banUserMenu = Markup.inlineKeyboard([
                                [Markup.button.callback('Disable', `${rule.type}RuleBanUserDisable`)],
                                [Markup.button.callback('Warn before banning', `${rule.type}RuleBanUserWarn`)],
                                [Markup.button.callback(`Back to ${rule.title} Menu`, `${rule.type}`)]
                            ]);

                    } else if (warnings == -1) {
                        currentStatus = 'Disabled'

                        banUserMenu = Markup.inlineKeyboard([
                                [Markup.button.callback('Ban Immediately', `${rule.type}RuleBanUserImmediately`)],
                                [Markup.button.callback('Warn before banning', `${rule.type}RuleBanUserWarn`)],
                                [Markup.button.callback(`Back to ${rule.title} Menu`, `${rule.type}`)]
                            ]);

                    } else {
                        currentStatus = `Ban after ${warnings} warnings`

                        banUserMenu = Markup.inlineKeyboard([
                                [Markup.button.callback('Disable', `${rule.type}RuleBanUserDisable`)],
                                [Markup.button.callback('Ban Immediatelly', `${rule.type}RuleBanUserImmediately`)],
                                [Markup.button.callback('Warn before banning', `${rule.type}RuleBanUserWarn`)],
                                [Markup.button.callback(`Back to ${rule.title} Menu`, `${rule.type}`)]
                            ]);

                    }
                    ctx.reply(`Ban User Setting is ${currentStatus}`, banUserMenu)
                }
            })

            this.botApiProcessor.action(`${rule.type}RuleBanUserImmediately`, (ctx) => {
                if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                    if (this.botConfigurator.processBanUserRule(rule.type, '0')) {
                        ctx.reply("Ban User Setting is set to Ban Immediately")
                    } else {
                        ctx.reply("Invalid value for Ban User Setting Warning")
                    }
                }
            })

            this.botApiProcessor.action(`${rule.type}RuleBanUserDisable`, (ctx) => {
                if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                    if (this.botConfigurator.processBanUserRule(rule.type, '-1')) {
                        ctx.reply("Ban User Setting is set to Disabled")
                    } else {
                        ctx.reply("Invalid value for Ban User Setting Warning")
                    }
                }
            })

            this.botApiProcessor.action(`${rule.type}RuleBanUserWarn`, (ctx) => {
                if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                    this.lastConfigRule = rule.type
                    ctx.reply("Enter Number of Warnings")
                }
            })

        })


        this.botApiProcessor.action('badWords', (ctx) => {
            if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                let currentWords = this.botConfigurator.getConfiguration().badWords
                currentWords = currentWords.replace("(", "").replace(")", "").split("|").join(", ")

                let badWordsMenu = Markup.inlineKeyboard([
                        [Markup.button.callback('Add Word/Phrase', 'badWordsSetWord')],
                        [Markup.button.callback('Remove Word/Phrase', 'badWordsUnsetWord')],
                        [Markup.button.callback('Back to Main Menu', 'mainMenu')]
                    ]);

                this.lastConfigRule = ''
                ctx.reply(`Current Banned Word/Phrase(s) are ${currentWords}`, badWordsMenu)
            }
        })

        this.botApiProcessor.action('badWordsSetWord', (ctx) => {
            if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                this.lastConfigRule = 'badWordsSet'
                ctx.reply("Enter Word/Phrase(s) to add delimited with comma")
            }
        })

        this.botApiProcessor.action('badWordsUnsetWord', (ctx) => {
            if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                this.lastConfigRule = 'badWordsUnset'
                ctx.reply("Enter Word/Phrase(s) to remove delimited with comma")
            }
        })


        this.botApiProcessor.action('replyMessages', (ctx) => {
            if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                let currentWords = this.botConfigurator.getConfiguration().badWords
                currentWords = currentWords.replace("(", "").replace(")", "").split("|").join(", ")

                let replyMessagesMenu = Markup.inlineKeyboard([
                        [Markup.button.callback('Inappropriate Content Message', 'inappropriateContentReplyMessage')],
                        [Markup.button.callback('Wallet Address / Private Key Message', 'walletKeyReplyMessage')],
                        [Markup.button.callback('Posting Image Message', 'imageReplyMessage')],
                        [Markup.button.callback('Posting Video Message', 'videoReplyMessage')],
                        [Markup.button.callback('Posting Audio Message', 'audioReplyMessage')],
                        [Markup.button.callback('Posting URL Message', 'urlReplyMessage')],
                        [Markup.button.callback('Warning to Member', 'warningReplyMessage')]
                    ]);

                this.lastConfigRule = ''
                ctx.reply("Reply Messages", replyMessagesMenu)
            }
        })

        replyMessages.forEach(replyMessage => {
            this.botApiProcessor.action(`${replyMessage.type}`, (ctx) => {
                if (this.isAdminMessage(ctx.callbackQuery.from.id)) {
                    this.lastConfigRule = replyMessage.type
                    ctx.reply(`Current Reply Message is: ${this.botConfigurator.getConfiguration().replyMessages[replyMessage.type.replace('ReplyMessage', '')]}. \n\nEnter new Reply Message`)
                }
            })
        })

        // ── Blacklisted Names ─────────────────────────────────────────────────
        this.botApiProcessor.action('nameBlacklist', (ctx) => {
            if (!this.isAdminMessage(ctx.callbackQuery.from.id)) return
            const list: string[] = Array.isArray((this.botConfigurator.getConfiguration() as any).nameBlacklist)
                ? (this.botConfigurator.getConfiguration() as any).nameBlacklist
                : []
            const count = list.length
            const nameBlacklistMenu = Markup.inlineKeyboard([
                    [Markup.button.callback('➕ Add', 'nameBlacklistAdd'), Markup.button.callback('➖ Remove', 'nameBlacklistRemove')],
                    [Markup.button.callback('📋 List', 'nameBlacklistList')],
                    [Markup.button.callback('Back to Main Menu', 'mainMenu')]
                ])
            this.lastConfigRule = ''
            ctx.reply(`Blacklisted Names (${count} keyword${count !== 1 ? 's' : ''})`, nameBlacklistMenu)
        })

        this.botApiProcessor.action('nameBlacklistAdd', (ctx) => {
            if (!this.isAdminMessage(ctx.callbackQuery.from.id)) return
            this.lastConfigRule = 'nameBlacklistAdd'
            ctx.reply('Enter the keyword to add to the name blacklist:')
        })

        this.botApiProcessor.action('nameBlacklistRemove', (ctx) => {
            if (!this.isAdminMessage(ctx.callbackQuery.from.id)) return
            this.lastConfigRule = 'nameBlacklistRemove'
            ctx.reply('Enter the keyword to remove from the name blacklist:')
        })

        this.botApiProcessor.action('nameBlacklistList', (ctx) => {
            if (!this.isAdminMessage(ctx.callbackQuery.from.id)) return
            const list: string[] = Array.isArray((this.botConfigurator.getConfiguration() as any).nameBlacklist)
                ? (this.botConfigurator.getConfiguration() as any).nameBlacklist
                : []
            const reply = list.length === 0
                ? 'Name blacklist is empty.'
                : `Current blacklisted keywords (${list.length}):\n\n${list.map((w, i) => `${i + 1}. ${w}`).join('\n')}`
            ctx.reply(reply)
        })

        // ── Member Management (runs via external Python script) ──────────────
        const memberMgmtMenu = async (ctx) => {
            const fs = require('fs')
            const configPath = require('path').join(__dirname, '../../telethon_config.json')
            let configured = false
            try {
                const c = JSON.parse(fs.readFileSync(configPath, 'utf8'))
                configured = !!(c.api_id && c.api_hash)
            } catch (e) { configured = false }

            const statusLine = configured
                ? 'Telethon API: configured'
                : 'Telethon API: not configured - set up credentials first'

            const buttons: any[] = []
            if (!configured) {
                buttons.push([{ text: 'Setup Telethon API credentials', callback_data: 'mmSetup' }])
            } else {
                buttons.push([{ text: 'Export members from Telegram',    callback_data: 'mmExport'     }])
                buttons.push([{ text: 'Import members to DB',            callback_data: 'mmImport'     }])
                buttons.push([{ text: 'Scan for deleted accounts',       callback_data: 'mmScan'       }])
                buttons.push([{ text: 'Scan and ban deleted accounts',   callback_data: 'mmCleanup'    }])
                buttons.push([{ text: 'Cross-check report only',       callback_data: 'mmCrosscheckDry' }])
                buttons.push([{ text: 'Cross-check & ban deleted',       callback_data: 'mmCrosscheck'    }])
            }
            buttons.push([{ text: 'Back to Main Menu', callback_data: 'mainMenu' }])

            await ctx.reply(
                'Member Management\n' + statusLine + '\n\nAll operations run in the background and report back here when done.',
                { reply_markup: { inline_keyboard: buttons } }
            )
        }

        this.botApiProcessor.action('cleanDeleted', async (ctx) => {
            if (!this.isAdminMessage(ctx.callbackQuery.from.id)) return
            await memberMgmtMenu(ctx)
        })

        this.botApiProcessor.action('mmSetup', (ctx) => {
            if (!this.isAdminMessage(ctx.callbackQuery.from.id)) return
            this.lastConfigRule = 'mmApiId'
            ctx.reply('Enter your Telethon API ID (the number from my.telegram.org):')
        })

        const spawnMemberScript = (command: string, adminId: number, ctx, stopBot: boolean = false) => {
            const { spawn } = require('child_process')
            const scriptPath = require('path').join(__dirname, '../../manage_members.py')
            const botToken = this.botConfigurator.getConfiguration().botToken

            if (stopBot) {
                ctx.reply('Stopping bot for safe DB operation. Bot will restart automatically when done.')
                this.log('Admin ' + this.adminName(adminId) + ' triggered member management: ' + command + ' (bot will stop and restart)')
                // Write a flag file so start.sh knows to run the script before restarting
                const fs = require('fs')
                const flagPath = require('path').join(__dirname, '../../pending_operation.json')
                fs.writeFileSync(flagPath, JSON.stringify({ command, adminId, botToken }))
                // Exit cleanly — start.sh restart loop will pick up the flag
                setTimeout(() => process.exit(0), 1000)
            } else {
                ctx.reply('Starting ' + command + '... I will message you here when done.')
                this.log('Admin ' + this.adminName(adminId) + ' triggered member management: ' + command)
                const fs = require('fs')
                const path = require('path')
                const proc = spawn('python3', ['-u', scriptPath, command, String(adminId), botToken], {
                    cwd: path.join(__dirname, '../..'),
                    detached: true,
                    stdio: ['ignore', 'pipe', 'pipe']
                })
                // Write output to console only — rotate_and_log in start.sh handles the log file
                proc.stdout.on('data', (data) => { process.stdout.write(data.toString()) })
                proc.stderr.on('data', (data) => { process.stderr.write(data.toString()) })
                proc.unref()
            }
        }

        this.botApiProcessor.action('mmExport', async (ctx) => {
            if (!this.isAdminMessage(ctx.callbackQuery.from.id)) return
            spawnMemberScript('export', ctx.callbackQuery.from.id, ctx, false)
        })

        this.botApiProcessor.action('mmImport', async (ctx) => {
            if (!this.isAdminMessage(ctx.callbackQuery.from.id)) return
            spawnMemberScript('import', ctx.callbackQuery.from.id, ctx, false)
        })

        this.botApiProcessor.action('mmScan', async (ctx) => {
            if (!this.isAdminMessage(ctx.callbackQuery.from.id)) return
            spawnMemberScript('scan', ctx.callbackQuery.from.id, ctx, false)
        })

        this.botApiProcessor.action('mmCleanup', async (ctx) => {
            if (!this.isAdminMessage(ctx.callbackQuery.from.id)) return
            spawnMemberScript('cleanup', ctx.callbackQuery.from.id, ctx, false)
        })

        this.botApiProcessor.action('mmCrosscheckDry', async (ctx) => {
            if (!this.isAdminMessage(ctx.callbackQuery.from.id)) return
            // Report only — no bans, bot does NOT need to stop
            spawnMemberScript('crosscheckdry', ctx.callbackQuery.from.id, ctx, false)
        })

        this.botApiProcessor.action('mmCrosscheck', async (ctx) => {
            if (!this.isAdminMessage(ctx.callbackQuery.from.id)) return
            spawnMemberScript('crosscheck', ctx.callbackQuery.from.id, ctx, false)
        })
    }

    private async connectToDatabase() {
		try {
			let connectionOptions = this.botConfigurator.getConfiguration().database[
				this.botConfigurator.getConfiguration().database.useDatabase.toLowerCase()
			]

			connectionOptions.insecureAuth = true
			connectionOptions.entities = [ChatMember, MemberHistory]

			this.dbConnection = await createConnection(connectionOptions)

			// Enable WAL mode for safer concurrent access with Python scripts
			await this.dbConnection.query('PRAGMA journal_mode=WAL;')

			this.botMessage.displayMessage("Successfully connected to database")

			// Log member count as a startup sanity check
			const memberCount = await this.dbConnection.getRepository(ChatMember).count()
			const activeCount = await this.dbConnection.getRepository(ChatMember).count({ where: { status: 'active' } })
			this.log(`Database ready — ${memberCount} total members (${activeCount} active)`)

		} catch (e) {
			this.log("Unable to connect to database", { message: e.message })
			this.log("Exiting...")
			process.exit(1)
		}
	}

}
