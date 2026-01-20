import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  SwapTreeSerializer,
  TaprootUtils,
  Musig,
  Networks,
  constructClaimTransaction,
  targetFee,
  detectSwap,
  OutputType,
} from "boltz-core";
import { randomBytes } from "crypto";
import { Address, OutScript, SigHash, Transaction } from "@scure/btc-signer";

// Endpoint of the Boltz instance to be used
const endpoint = "http://127.0.0.1:9006";

// Amount you want to swap
const userLockAmount = 100_000;

const destinationAddress = "bcrt1qtrtsds7f6su9jgqg24r5w7k8sfw76szl626v93";
const network = Networks.regtest;

const arkPublicKey = hex.decode(
  "0287cc2a12b37f6f278cd3807df0c8b8b2affde1bed8064447781ac50155754107"
);

const chainSwap = async () => {
  // Create a random preimage for the swap; has to have a length of 32 bytes
  const preimage = randomBytes(32);
  const claimKeys = secp256k1.utils.randomSecretKey();

  // Create a Chain Swap
  const createdResponse: any = await (
    await fetch(`${endpoint}/v2/swap/chain`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // The amount is optional; you can always wait for "transaction.lockupFailed"
        // and try to get a quote
        userLockAmount,
        from: "ARK",
        to: "BTC",
        preimageHash: hex.encode(sha256(preimage)),
        claimPublicKey: hex.encode(secp256k1.getPublicKey(claimKeys)),
        refundPublicKey: hex.encode(arkPublicKey),
      }),
    })
  ).json();

  console.log("Created swap");
  console.log(createdResponse);
  console.log();

  const webSocket = new WebSocket(`${endpoint}/v2/ws`);
  webSocket.addEventListener("open", () => {
    webSocket.send(
      JSON.stringify({
        op: "subscribe",
        channel: "swap.update",
        args: [createdResponse.id],
      })
    );
  });

  webSocket.addEventListener("message", async (rawMsg: MessageEvent) => {
    const msg: any = JSON.parse(rawMsg.data.toString());
    if (msg.event !== "update") {
      return;
    }

    console.log("Got WebSocket update");
    console.log(msg);
    console.log();

    switch (msg.args[0].status) {
      // "swap.created" means Boltz is waiting for coins to be locked
      case "swap.created": {
        console.log("Waiting for coins to be locked");
        break;
      }

      // If the lockup fails, we need to fetch a approve a new quote
      case "transaction.lockupFailed": {
        console.log("Lockup failed, fetching quote");

        // GET request to fetch the quote
        const quoteResponse = await fetch(
          `${endpoint}/v2/swap/chain/${createdResponse.id}/quote`,
          {
            method: "GET",
            headers: {
              accept: "application/json",
            },
          }
        );

        const quoteData: any = await quoteResponse.json();
        console.log("Quote data:", quoteData);

        // POST the amount back to the same URL
        const postResponse = await fetch(
          `${endpoint}/v2/swap/chain/${createdResponse.id}/quote`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              amount: quoteData.amount,
            }),
          }
        );

        const postData = await postResponse.json();
        console.log("Posted amount response:", postData);
        break;
      }

      // "transaction.server.mempool" means that Boltz sent an onchain transaction
      // Alternatively, you can wait for "transaction.confirmed" if you want to wait for the lockup transaction to be confirmed
      case "transaction.server.mempool": {
        console.log("Claiming UTXO");

        const lockupTx = Transaction.fromRaw(
          hex.decode(msg.args[0].transaction.hex)
        );

        const swapTree = SwapTreeSerializer.deserializeSwapTree(
          createdResponse.claimDetails.swapTree
        );

        const musig = TaprootUtils.tweakMusig(
          Musig.create(claimKeys, [
            hex.decode(createdResponse.claimDetails.serverPublicKey),
            secp256k1.getPublicKey(claimKeys),
          ]),
          swapTree.tree
        );
        const swapOutput = detectSwap(musig.aggPubkey, lockupTx)!;

        const claimTx = targetFee(1, (fee) =>
          constructClaimTransaction(
            [
              {
                preimage,
                type: OutputType.Taproot,
                script: swapOutput.script!,
                amount: swapOutput.amount!,
                vout: swapOutput.vout!,
                privateKey: claimKeys,
                transactionId: lockupTx.id,
                swapTree: swapTree,
                internalKey: musig.internalKey,
                // False to enforce script path
                cooperative: true,
              },
            ],
            OutScript.encode(Address(network).decode(destinationAddress)),
            fee
          )
        );

        const musigMessage = musig
          .message(
            claimTx.preimageWitnessV1(
              0,
              [swapOutput.script!],
              SigHash.DEFAULT,
              [swapOutput.amount!]
            )
          )
          .generateNonce();

        console.log("Claim transaction:", claimTx.hex);

        const postClaim = await fetch(
          `${endpoint}/v2/swap/chain/${createdResponse.id}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              preimage: hex.encode(preimage),
              toSign: {
                pubNonce: hex.encode(musigMessage.publicNonce),
                transaction: claimTx.hex,
                index: 0,
              },
            }),
          }
        );

        const signedTxData = (await postClaim.json()) as {
          pubNonce: string;
          partialSignature: string;
        };
        console.log("Signed transaction:", signedTxData);

        const musigSession = musigMessage
          .aggregateNonces([
            [
              hex.decode(createdResponse.claimDetails.serverPublicKey),
              hex.decode(signedTxData.pubNonce),
            ],
          ])
          .initializeSession();

        musigSession.addPartial(
          hex.decode(createdResponse.claimDetails.serverPublicKey),
          hex.decode(signedTxData.partialSignature)
        );
        const musigSigned = musigSession.signPartial();

        claimTx.updateInput(0, {
          finalScriptWitness: [musigSigned.aggregatePartials()],
        });

        const broadcastResponse = await fetch(
          `${endpoint}/v2/chain/BTC/transaction`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              hex: claimTx.hex,
            }),
          }
        );

        const broadcastData = await broadcastResponse.json();
        console.log("Broadcast response:", broadcastData);

        break;
      }

      case "transaction.claimed":
        console.log("Swap successful");
        webSocket.close();
        break;
    }
  });
};

(async () => {
  await chainSwap();
})();
