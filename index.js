require("dotenv").config();
const API_KEY = process.env.POAP_API_KEY;
const DISCORD_CHANNELS = JSON.parse(process.env.DISCORD_CHANNELS_NAMES);

//set the enviornment variables in a .env file
const {
    DISCORD_TOKEN,
    DISCORD_CHANNEL_NAME,
    XDAI_WS_PROVIDER,
    MAINNET_WS_PROVIDER,
} = process.env;

//Initial xDai/blockchain code by @brunitob
const Web3 = require("web3");
const PoapAbi = require("./poap.json");
const POAP_XDAI_CONTRACT = "0x22C1f6050E56d2876009903609a2cC3fEf83B415";
const ZEROX = "0x0000000000000000000000000000000000000000";

const { default: axios } = require("axios");
const Discord = require("discord.js");

// Networks availables
const XDAI_NETWORK = "XDAI";
const MAINNET_NETWORK = "MAINNET";
const MINT_ACTION = "MINT";
const TRANSFER_ACTION = "TRANSFER";
const BURN_ACTION = "BURN";

const options = {
    // Enable auto reconnection
    reconnect: {
        auto: true,
        delay: 5000, // ms
        maxAttempts: 20,
        onTimeout: false,
    },
};
const axiosRetry = require('axios-retry');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const bot = new Discord.Client();

bot.login(DISCORD_TOKEN);
bot.on("ready", () => {
    console.info(`Discord Bot logged in: ${bot.user.tag}!`);
});

const start = () => {
    console.log("+*+*+*+*+*+*+*+*+*+*+*+*+*+*+");
    console.log("Starting to listen POAP events...");
    console.log("+*+*+*+*+*+*+*+*+*+*+*+*+*+*+");

    const web3xDai = new Web3(
        new Web3.providers.WebsocketProvider(XDAI_WS_PROVIDER, options)
    );
    const web3Mainnet = new Web3(
        new Web3.providers.WebsocketProvider(MAINNET_WS_PROVIDER, options)
    );

    axiosRetry(axios, {
        retries: 6, // number of retries
        retryDelay: (retryCount) => {
            console.log(`Retry attempt: ${retryCount}`);
            return retryCount * 5000; // time interval between retries
        },
        retryCondition: (error) => {
            // if retry condition is not specified, by default idempotent requests are retried
            return error.response.status >= 400;
        },
    });

    subscribeToTransfer(web3xDai, POAP_XDAI_CONTRACT, XDAI_NETWORK);
    subscribeToTransfer(web3Mainnet, POAP_XDAI_CONTRACT, MAINNET_NETWORK);
};

const subscribeToTransfer = (web3, address, network) => {
    let lastHash = ""
    console.log(`Subscribing to ${network} - ${address} `);
    const PoapContract = new web3.eth.Contract(PoapAbi, address);
    PoapContract.events
        .Transfer(null)
        .on("data", async (result) => {
            // console.log(result)
            try {
                const tokenId = result.returnValues.tokenId;
                const fromAddress = result.returnValues.from;
                const toAddress = result.returnValues.to;
                const txHash = result.transactionHash;

                console.log(`TokenId: ${tokenId}, to: ${toAddress}, tx: ${txHash}`);
                const action = fromAddress === ZEROX ? MINT_ACTION : toAddress === ZEROX ? BURN_ACTION : TRANSFER_ACTION;
                const tokenInfo = await getTokenById(tokenId);

                if (tokenInfo && tokenInfo.image_url && lastHash !== txHash) {
                    await sendPoapEmbeddedMessage(
                        tokenInfo.image_url,
                        action,
                        tokenId,
                        tokenInfo.id,
                        tokenInfo.name,
                        toAddress,
                        tokenInfo.poapPower,
                        tokenInfo.ens,
                        network
                    );
                    await sendPoapSlackMessage(
                        tokenInfo.image_url,
                        action,
                        tokenId,
                        tokenInfo.id,
                        tokenInfo.name,
                        toAddress,
                        tokenInfo.poapPower,
                        tokenInfo.ens,
                        network
                    );
                    lastHash = txHash;
                }
            } catch (e){
                console.error("ERROR SENDING DISCORD MESSAGE");
                console.error(e);
            }
        })
        .on("connected", (subscriptionId) => {
            console.log(`Connected to ${network} - ${subscriptionId} `);
        })
        .on("changed", (log) => {
            console.log(`Changed to ${network} - ${log} `);
        })
        .on("error", (error) => {
            console.error(`Error to ${network} - ${error} `);
        });
};

const getTokenById = async (tokenId) => {
    let event, ens, address, poapPower = undefined;
    try {
        await sleep(5000);
        const tokenData = await axios.get(`https://api.poap.tech/token/${tokenId}`, {
            headers: {
                'x-api-key': API_KEY,
            }
        });
        event = tokenData.data.event;
        address = tokenData.data.owner;

        const addressPoaps = await axios.get(`https://api.poap.tech/actions/scan/${address}`, {
            headers: {
                'x-api-key': API_KEY,
            }
        });
        poapPower = (addressPoaps.data.length) > 0 ? addressPoaps.data.length : 0;

        try {
            const profileData = await axios.get(`https://profiles.poap.tech/profile/${address}`);
            ens = profileData.data.ens;
        } catch (ensError) {
            console.warn(`Could not fetch ENS for address ${address}:`, ensError.message);
            ens = undefined;
        }
    } catch (e) {
        console.error("ERROR FETCHING API:")
        console.error(e);
    }

    if(!(event && event.id && event.name && event.image_url)){
        return undefined;
    }
    poapPower = (poapPower !== undefined)? poapPower : 0;

    const { id, name, image_url } = event;
    return {
        id,
        name,
        address,
        image_url,
        poapPower,
        ens,
    };
}
const sendPoapSlackMessage = async (
    imageUrl,
    actionType,
    poapId,
    dropId,
    dropName,
    plainAddress,
    poapPower,
    ens,
    network
) => {
    if(actionType !== MINT_ACTION){
        return;
    }

    const address = ens ? ens : plainAddress;
    const familyUrl = `https://poap.family/event/${dropId}?utm_share=slackfeed`;
    const galleryUrl = `https://poap.gallery/event/${dropId}?utm_share=slackfeed`;
    const scanUrl = `https://app.poap.xyz/scan/${address}/?utm_share=slackfeed`;
    const data = { imageUrl, actionType, poapId, dropId, dropName, address, poapPower, ens, network, galleryUrl, scanUrl, familyUrl };
    try {
        await axios.post("https://hooks.slack.com/triggers/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", data);
    } catch (e) {
        console.log("Error while trying to send slack message");
        console.error(e);
    }
};

const sendPoapEmbeddedMessage = async (
    imageUrl,
    actionType,
    tokenId,
    eventId,
    eventName,
    address,
    poapPower,
    ens,
    network
) => {
    // Create the embedded message using the Discord MessageEmbed API
    const messageEmbed = new Discord.MessageEmbed()
        .setTitle(`${actionType}: ${eventName} `)
        .setColor(network === MAINNET_NETWORK ? "#5762cf" : "#48A9A9")
        .addFields(
            { name: "POAP Power", value: `${emoji(poapPower)}  ${poapPower}`, inline: true },
            { name: "Token ID", value: `#${tokenId}`, inline: true },
            { name: "Event ID", value: `#${eventId}`, inline: true }
        )
        .setURL(`https://poap.gallery/event/${eventId}/?utm_share=discordfeed`)
        .setTimestamp()
        .setAuthor(
            ens ? ens : address.toLowerCase(),
            ``,
            `https://app.poap.xyz/scan/${address}/?utm_share=discordfeed`
        )
        .setThumbnail(imageUrl);

    // Call the broadcastMessage function to send the message to all relevant channels
    broadcastMessage(actionType, messageEmbed);
};

const broadcastMessage = async (actionType, messageEmbed) => {
    // Iterate through all the channels
    DISCORD_CHANNELS.forEach((channelConfig) => {
        // Check if specific actions are defined for this channel
        const hasDefinedActions = Array.isArray(channelConfig.actions) && channelConfig.actions.length;
        const uppercaseActions = (Array.isArray(channelConfig.actions)? channelConfig.actions : []).map((action) => action.toUpperCase());
        // If the channel has defined actions and the current action is not one of them, we skip this channel
        if (hasDefinedActions && !uppercaseActions.includes(actionType.toUpperCase())) {
            return;
        }

        // Send message to the specific channel
        sendMessageToChannel(channelConfig, messageEmbed);
    });
};

const sendMessageToChannel = async (channelConfig, messageEmbed) => {
    // Find the corresponding Discord channel by name
    const discordChannel = bot.channels.cache.find(
        (channel) => channel.name === channelConfig.name
    );

    // If the channel does not exist, we return
    if (!discordChannel) return;

    //console.log("Sending message to channel: " + channelConfig.name);
    //console.log(messageEmbed);
    // Send the message to the channel
    discordChannel.send(messageEmbed);
};

const emoji = (poapPower) => {
    return poapPower <= 5
        ? "🆕 "
        : poapPower <= 10
            ? "🟢 "
            : poapPower <= 20
                ? "🟡 "
                : poapPower <= 50
                    ? "🔴 "
                    : "🔥 ";
};

start();