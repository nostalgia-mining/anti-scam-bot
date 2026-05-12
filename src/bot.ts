import { BotProcessor } from "./bot-processor/bot-processor"
const { version } = require('../package.json')

const banner = [
    '',
    '╔═════════════════════════════════════╗',
    `║   Anti-Scam Bot  v${version.padEnd(18)}║`,
    '║   by nostalgia                      ║',
    '╚═════════════════════════════════════╝',
    ''
].join('\n')

console.log(banner)

;(async () => {
    const bot = new BotProcessor()
    await bot.start()
})().catch(console.error)
