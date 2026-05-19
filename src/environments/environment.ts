export const environment = {
  "database": {
    "mysql": {
      "type": "mysql",
      "hostname": "database host",
      "port": 3306,
      "database": "database name",
      "username": "database user",
      "password": "database password"
    },
    "sqlite": {
      "type": "sqlite",
      "database": "zenchain_bot_sqlite.db",
      "insecureAuth": true,
      "entities": [
        null,
        null
      ]
    },
    "useDatabase": "sqlite"
  },
  "botToken": "8632885702:AAFoNM_4ABi7omYcI_Czu0xY4mlHr5qKECM",
  "chatId": "-1001701085050",
  "checkMemberInterval": "5000",
  "rules": {
    "checkAdmin": {
      "validate": true,
      "banUser": "0"
    },
    "checkBadWord": {
      "validate": true,
      "removeMessage": true,
      "banUser": "1"
    },
    "checkWalletKey": {
      "validate": false,
      "removeMessage": true,
      "banUser": "1"
    },
    "checkAudio": {
      "validate": false,
      "removeMessage": false,
      "banUser": "-1"
    },
    "checkVideo": {
      "validate": false,
      "removeMessage": false,
      "banUser": "-1"
    },
    "checkImage": {
      "validate": false,
      "removeMessage": false,
      "banUser": "-1"
    },
    "checkUrl": {
      "validate": false,
      "removeMessage": false,
      "banUser": "-1"
    },
    "checkAnyFile": {
      "validate": false,
      "removeMessage": false,
      "banUser": "-1"
    }
  },
  "badWords": "( direct message|directly|privately|direct message|private message|Drop me|for assistance|message first|attend to|Reach out to me|Connect with me|Please send me|send me a dm|check it with the team|redirect your issue|to my inbox|for further assistance)",
  "urlRegex": "(http|https):",
  "walletAddress": [
    "(\\b0x[a-f0-9]{40,}\\b)",
    "(\\b[0-9a-z]{34,}\\b)"
  ],
  "replyMessages": {
    "inappropriateContent": "/safety",
    "walletKey": "The message has been deleted because it contained Wallet address or private key",
    "image": "The message has been deleted because it contained image",
    "video": "The message has been deleted because it contained video",
    "audio": "The message has been deleted because it contained audio",
    "url": "The message has been deleted because it contained external link (url)",
    "warning": "Potential impersonator alert"
  },
  "displayMessages": false,
  "validChars": {}
}