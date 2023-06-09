import * as sharedArray from './utils/sharedArray'
import { validateTransfer } from './solana_pay/validateTransfer';
import { findReference, FindReferenceError } from './solana_pay/findReference'
import BigNumber from 'bignumber.js';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import express from 'express';
import { MongoClient, ObjectId, Timestamp } from 'mongodb';
import dotenv from 'dotenv';
import { calcAmountPayment } from './solana_pay/calcAmount';

const KEY_TESTNET_DATA = "KEY_TESTNET_DATA"
const KEY_TESTNET_DATA_VALIDATE = "KEY_TESTNET_DATA_VALIDATE"
const KEY_MAINNET_DATA = "KEY_MAINNET_DATA"
const KEY_MAINNET_DATA_VALIDATE = "KEY_MAINNET_DATA_VALIDATE"
const KEY_DEVNET_DATA = "KEY_DEVNET_DATA"
const KEY_DEVNET_DATA_VALIDATE = "KEY_DEVNET_DATA_VALIDATE"

interface Data {
    db_id: string;
    reference: string;
    recipient: string;
    amount: number;
    network: string;
    expiration: number;
    createdAt: Date;
}

interface Err {
    error: string
}

interface StatusCheckTransaction {
    status: string
    amount: string
}

interface Link {
    _id: string;
    nickname: string;
    userId: string;
    accountId: string;
    link: string;
    reference: string;
    recipient: string;
    network: string;
    expectedAmount: number;
    status: string;
    createdAt: Date;
    amountReceived: number;
    expiration: number;
    expired: boolean;
}

function nowFormated() {
    const now = new Date();
    const dateTimeString = now.toISOString().replace("T", " ").replace("Z", "");
    return dateTimeString;
}

async function checker(array: Data[], connection: Connection, keyArray: string, keyArrayValidate: string) {
    const interval = setInterval(async () => {
        console.log(`${nowFormated()} : checker : ${keyArray} : ${array.length} links ativos`);
        let newArray = await sharedArray.copySharedArray(keyArray, array);
        let validateTransactions: Data[] = []

        const promises = newArray.map(async (element) => {
            try {
                const recipient = new PublicKey(element.recipient);
                const amount = new BigNumber(element.amount);
                const reference = new PublicKey(element.reference);
                const expiration = element.expiration;
                const createdAt = element.createdAt;

                if (expiration > 0) {
                    const dateNow = new Date();
                    const dateCreated = new Date(createdAt);
                    console.log(dateCreated, createdAt)
                    const diffInMs = Math.abs(dateNow.getTime() - dateCreated.getTime());
                    const diffInMinutes = Math.floor(diffInMs / 60000);
                    console.log(diffInMinutes)
                    if (diffInMinutes >= expiration) {
                        await Database.getInstance().updateStatusExpired(element);
                        await sharedArray.addToSharedArray(keyArrayValidate, validateTransactions, element)
                        return;
                    }
                }

                let statusTransaction = await checkTransaction(connection, reference, amount, recipient)
                console.log(`[x] checker : statusTransaction = ${JSON.stringify(statusTransaction)}`);

                if (statusTransaction.status === "received_total" || statusTransaction.status === "received_incomplete") {
                    await Database.getInstance().updateStatusReceived(element, statusTransaction.status, statusTransaction.amount.toString());
                    await sharedArray.addToSharedArray(keyArrayValidate, validateTransactions, element)
                }
            } catch (error) {
                console.log(`[x] checker : error = ${error}`);
            }
        });

        await Promise.all(promises);

        const removePromises = validateTransactions.map(async (element) => {
            await sharedArray.removeFromSharedArray(keyArray, array, (value: any) => value === element);
        });

        await Promise.all(removePromises);
    }, 7000);
}

async function checkTransaction(connection: Connection, reference: PublicKey, amount: BigNumber, recipient: PublicKey) {
    try {
        let signatureInfo = await findReference(connection, reference, { finality: 'confirmed' });
        console.log(`[x] checkTransaction : signature found : reference = ${reference.toString()} : signature = ${signatureInfo.signature}`);
        try {
            await validateTransfer(connection, signatureInfo.signature, { recipient: recipient, amount });
            console.log(`[x] checkTransaction : payment validate : reference = ${reference.toString()}`);
            let status: StatusCheckTransaction = { status: "received_total", amount: amount.toString() }
            return status
        } catch (error: any) {
            if (error.name === "ValidateTransferError" && error.message === "amount not transferred") {
                console.log(`[x] checkTransaction : amount not transferred : reference = ${reference.toString()} : error = ${error}`);
                let amountCalculation = await calcAmountPayment(connection, signatureInfo.signature, { recipient: recipient, amount });
                let status: StatusCheckTransaction = { status: "received_incomplete", amount: amountCalculation }
                return status
            }
            console.log(`[x] checkTransaction : payment validate failed : reference = ${reference.toString()} : error = ${error}`);
            let status: StatusCheckTransaction = { status: "failed", amount: "0" }
            return status
        }
    } catch (error: any) {
        if (!(error instanceof FindReferenceError)) {
            console.log(`[x] checkTransaction : error = ${error}`);
            let status: StatusCheckTransaction = { status: "error", amount: "0" }
            return status
        }
        let status: StatusCheckTransaction = { status: "not-found", amount: "0" }
        return status
    }
}

class Database {
    private static instance: Database;
    private client: MongoClient | undefined;
    private db: any;
    private collection: any;

    private constructor() { }

    public static async createInstance(uri: string, dbName: string, collectionName: string) {
        if (!Database.instance) {
            Database.instance = new Database();
            await Database.instance.connect(uri, dbName, collectionName);
        }
    }

    public static getInstance() {
        return Database.instance;
    }

    private async connect(uri: string, dbName: string, collectionName: string): Promise<void> {
        if (!this.client) {
            this.client = await MongoClient.connect(uri);
            this.db = this.client.db(dbName);
            this.collection = this.db.collection(collectionName);
        }
    }

    public async updateStatus(data: Data, status: string, amount: string): Promise<void> {
        try {
            const amountNumber = Number(amount);
            const query = { _id: new ObjectId(data.db_id) };
            const update = { $set: { status: status, amountReceived: amountNumber } };

            await this.collection.updateOne(query, update);

            console.log(`[X] updateStatus : document ${data.db_id} updated`);
        } catch (error: any) {
            console.log(`[X] updateStatus : error = ${error} : data = ${JSON.stringify(data)} : status = ${status}`);
        }
    }

    public async updateStatusExpired(data: Data): Promise<void> {
        try {
            const now = new Date();
            const query = { _id: new ObjectId(data.db_id) };
            const update = { $set: { status: "expired", expired: true } };
            await this.collection.updateOne(query, update);
            console.log(`[X] updateStatusExpired : document ${data.db_id} updated : expired = true`);
        } catch (error: any) {
            console.log(`[X] updateStatusExpired : error = ${error} : _id = ${data.db_id}`);
        }
    }


    public async updateStatusReceived(data: Data, status: string, amount: string): Promise<void> {
        try {
            const amountNumber = Number(amount);
            const query = { _id: new ObjectId(data.db_id) };
            const update = { $set: { status: status, amountReceived: amountNumber, receivedAt: nowFormated() } };

            await this.collection.updateOne(query, update);

            console.log(`[X] updateStatus : document ${data.db_id} updated`);
        } catch (error: any) {
            console.log(`[X] updateStatus : error = ${error} : data = ${JSON.stringify(data)} : status = ${status}`);
        }
    }

    public async getDatasByStatus(): Promise<Link[]> {
        const query = { status: { $in: ["created", "pending"] } };
        const cursor = this.collection.find(query);
        const links = await cursor.toArray();

        console.log(`[X] getLinksByStatus : found ${links.length} links`);

        return links;
    }

    public async convertLinksToDatas(links: Link[]): Promise<Data[]> {
        let data: Data[] = links.map((link: Link) => ({
            db_id: link._id.toString(),
            reference: link.reference,
            recipient: link.recipient,
            amount: link.expectedAmount,
            network: link.network,
            expiration: link.expiration,
            createdAt: link.createdAt,
        }));
        return data;
    }

    public async close(): Promise<void> {
        if (this.client) {
            await this.client.close();
            console.log('[X] Database connection closed');
        }
    }
}

async function server(mainNetArray: Data[], testNetArray: Data[], devNetArray: Data[]) {
    const app = express();
    app.use(express.json());

    app.post('/link', (req, res) => {
        const data: Data = req.body;

        if (!data.db_id || !data.reference || !data.recipient || !data.amount || !data.network) {
            console.log("[X] dados invalidos: ", data);
            let err: Err = { error: "dados invalidos" }
            res.status(400).send(err);
            return
        }

        console.log("[X] mensagem recebida: ", data);

        switch (data.network) {
            case "mainnet":
                sharedArray.addToSharedArray(KEY_MAINNET_DATA, mainNetArray, data);
                break
            case "testnet":
                sharedArray.addToSharedArray(KEY_TESTNET_DATA, testNetArray, data);
                break
            case "devnet":
                sharedArray.addToSharedArray(KEY_DEVNET_DATA, devNetArray, data);
                break
            default:
                console.log("[X] network invalida: ", data.network);
                let err: Err = { error: "network invalida" }
                res.status(400).send(err);
                return
        }
        res.status(204).send();
    });

    app.listen(3000, () => {
        console.log('[X] Servidor iniciado na porta 3000');
    });
}

async function main() {
    dotenv.config();

    const mongodbUrl = process.env.MONGODB_URL;
    if (!mongodbUrl) {
        console.log(`[X] mongodbUrl not found`);
        return;
    }

    try {
        await Database.createInstance(mongodbUrl, 'mydb_backend', 'link');
        console.log('[X] Database connected');
    } catch (error: any) {
        console.log(`[X] Database connection error = ${error}`);
        return;
    }

    let links: Link[];
    try {
        links = await Database.getInstance().getDatasByStatus();
    } catch (error: any) {
        console.log(`[X] getDatasByStatus error = ${error}`);
        return;
    }

    let updatesStatusPendingMainnet = links
        .filter((link: Link) => link.network === "mainnet" && link.status === "created")
    let datasStatusPendingMainnet: Data[];
    try {
        datasStatusPendingMainnet = await Database.getInstance().convertLinksToDatas(updatesStatusPendingMainnet);
    } catch (error: any) {
        console.log(`[X] convertLinksToDatas error = ${error}`);
        return;
    }
    let updatesStatusPendingMainnetPromises = datasStatusPendingMainnet.map((data: Data) => Database.getInstance().updateStatus(data, "pending", "0"));
    await Promise.all(updatesStatusPendingMainnetPromises)
        .then(() => console.log(`[X] updated ${updatesStatusPendingMainnetPromises.length} link from mainnet network from created to pending`))
        .catch((error: any) => console.log(`[X] error updating ${updatesStatusPendingMainnetPromises.length} link from mainnet network from created to pending : error = ${error}`));



    let updatesStatusPendingTestnet = links
        .filter((link: Link) => link.network === "testnet" && link.status === "created")
    let datasStatusPendingTestnet: Data[];
    try {
        datasStatusPendingTestnet = await Database.getInstance().convertLinksToDatas(updatesStatusPendingTestnet);
    } catch (error: any) {
        console.log(`[X] convertLinksToDatas error = ${error}`);
        return;
    }
    let updatesStatusPendingTestnetPromises = datasStatusPendingTestnet.map((data: Data) => Database.getInstance().updateStatus(data, "pending", "0"));
    await Promise.all(updatesStatusPendingTestnetPromises)
        .then(() => console.log(`[X] updated ${updatesStatusPendingTestnetPromises.length} link from testnet network from created to pending`))
        .catch((error: any) => console.log(`[X] error updating ${updatesStatusPendingTestnetPromises.length} link from testnet network from created to pending : error = ${error}`));


    let updatesStatusPendingDevnet = links
        .filter((link: Link) => link.network === "devnet" && link.status === "created")
    let datasStatusPendingDevnet: Data[];
    try {
        datasStatusPendingDevnet = await Database.getInstance().convertLinksToDatas(updatesStatusPendingDevnet);
    } catch (error: any) {
        console.log(`[X] convertLinksToDatas error = ${error}`);
        return;
    }
    let updatesStatusPendingDevnetPromises = datasStatusPendingDevnet.map((data: Data) => Database.getInstance().updateStatus(data, "pending", "0"));
    await Promise.all(updatesStatusPendingDevnetPromises)
        .then(() => console.log(`[X] updated ${updatesStatusPendingDevnetPromises.length} link from devnet network from created to pending`))
        .catch((error: any) => console.log(`[X] error updating ${updatesStatusPendingDevnetPromises.length} link from devnet network from created to pending : error = ${error}`));



    let datasLink: Data[];
    try {
        datasLink = await Database.getInstance().convertLinksToDatas(links);
    } catch (error: any) {
        console.log(`[X] convertLinksToDatas error = ${error}`);
        return;
    }

    let linksMainNet: Data[] = datasLink.filter((data: Data) => data.network === "mainnet");
    let linksTestNet: Data[] = datasLink.filter((data: Data) => data.network === "testnet");
    let linksDevNet: Data[] = datasLink.filter((data: Data) => data.network === "devnet");


    console.log(`[X] linksMainNet = ${linksMainNet.length}`);
    console.log(`[X] linksTestNet = ${linksTestNet.length}`);
    console.log(`[X] linksDevNet = ${linksDevNet.length}`);

    server(linksMainNet, linksTestNet, linksDevNet)

    console.log(`[*] conectando a rede testnet solana`);
    const connectionTestNet = new Connection(clusterApiUrl("testnet"), 'confirmed');
    console.log(`[x] conectado a rede testnet solana`);
    checker(linksTestNet, connectionTestNet, KEY_TESTNET_DATA, KEY_TESTNET_DATA_VALIDATE);

    console.log(`[*] conectando a rede mainnet solana`);
    const connectionMainNet = new Connection(clusterApiUrl("mainnet-beta"), 'confirmed');
    console.log(`[x] conectado a rede mainnet solana`);
    checker(linksMainNet, connectionMainNet, KEY_MAINNET_DATA, KEY_MAINNET_DATA_VALIDATE);

    console.log(`[*] conectando a rede devnet solana`);
    const connectionDevNet = new Connection(clusterApiUrl("devnet"), 'confirmed');
    console.log(`[x] conectado a rede devnet solana`);
    checker(linksDevNet, connectionDevNet, KEY_DEVNET_DATA, KEY_DEVNET_DATA_VALIDATE);
}

main()