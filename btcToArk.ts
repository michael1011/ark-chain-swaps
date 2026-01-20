import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { SwapTreeSerializer, TaprootUtils, Musig } from "boltz-core";
import { randomBytes } from "crypto";

// Endpoint of the Boltz instance to be used
const endpoint = "http://127.0.0.1:9006";

// Amount you want to swap
const userLockAmount = 100_000;

const arkPublicKey = hex.decode(
  "0287cc2a12b37f6f278cd3807df0c8b8b2affde1bed8064447781ac50155754107"
);

const chainSwap = async () => {
  // Create a random preimage for the swap; has to have a length of 32 bytes
  const preimage = randomBytes(32);
  console.log("Preimage:", hex.encode(preimage));
  const refundKeys = secp256k1.utils.randomSecretKey();

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
        from: "BTC",
        to: "ARK",
        preimageHash: hex.encode(sha256(preimage)),
        claimPublicKey: hex.encode(arkPublicKey),
        refundPublicKey: hex.encode(secp256k1.getPublicKey(refundKeys)),
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
      case "transaction.server.mempool": {
        console.log("Waiting for claim transaction");
        // TODO: claim VTXO; I am doing that in a Fulmine gRPC

        break;
      }

      // Be nice and sign a cooperative claim for the server
      // Not required; you can treat this as success already; the server will batch sweep eventually
      case "transaction.claim.pending": {
        console.log("Claim pending, fetching claim details");

        // GET request to fetch the claim details
        const claimResponse = await fetch(
          `${endpoint}/v2/swap/chain/${createdResponse.id}/claim`,
          {
            method: "GET",
            headers: {
              accept: "application/json",
            },
          }
        );

        const claimDetails = (await claimResponse.json()) as {
          pubNonce: string;
          publicKey: string;
          transactionHash: string;
        };
        console.log("Claim details:", claimDetails);

        const musig = TaprootUtils.tweakMusig(
          Musig.create(refundKeys, [
            hex.decode(claimDetails.publicKey),
            secp256k1.getPublicKey(refundKeys),
          ]),
          SwapTreeSerializer.deserializeSwapTree(
            createdResponse.lockupDetails.swapTree
          ).tree
        );
        const musigNonces = musig
          .message(hex.decode(claimDetails.transactionHash))
          .generateNonce()
          .aggregateNonces([
            [
              hex.decode(createdResponse.lockupDetails.serverPublicKey),
              hex.decode(claimDetails.pubNonce),
            ],
          ])
          .initializeSession();

        const partialSig = musigNonces.signPartial();

        const postResponse = await fetch(
          `${endpoint}/v2/swap/chain/${createdResponse.id}/claim`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              signature: {
                partialSignature: hex.encode(partialSig.ourPartialSignature),
                pubNonce: hex.encode(partialSig.publicNonce),
              },
            }),
          }
        );

        const postData = await postResponse.json();
        console.log("Posted amount response:", postData);

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
