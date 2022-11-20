import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import {
  createApproveInstruction,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddress,
  MINT_SIZE,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { SYSVAR_CLOCK_PUBKEY, ParsedAccountData, PublicKey } from "@solana/web3.js";
import { expect } from 'chai';
import { PlaylinkAirdrop } from '../target/types/playlink_airdrop';

describe("Playlink Airdrop program", () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);
  const program = anchor.workspace.PlaylinkAirdrop as Program<PlaylinkAirdrop>;
  const connection = provider.connection;

  const defaultWallet = provider.wallet;
  const token1 = anchor.web3.Keypair.generate(); // FT
  const token2 = anchor.web3.Keypair.generate(); // NFT

  const admin = anchor.web3.Keypair.generate(); // Airdrop platform admin
  const operator = anchor.web3.Keypair.generate(); // Operator to perform airdrop
  const campaignCreator = anchor.web3.Keypair.generate();
  const participant = anchor.web3.Keypair.generate(); // campaign participant
  const recipient = anchor.web3.Keypair.generate(); // Airdrop fee recipient
  let airdropPlatform: PublicKey = null;

  it("Initialize new accounts", async () => {
    let initTx = new anchor.web3.Transaction().add(
      ...[
        admin.publicKey,
        operator.publicKey,
        campaignCreator.publicKey,
        participant.publicKey,
        recipient.publicKey
      ].map(account => anchor.web3.SystemProgram.transfer({
        fromPubkey: defaultWallet.publicKey,
        toPubkey: account,
        lamports: 1000000000
      }))
    );
    await provider.sendAndConfirm(initTx);
  });

  it("Create mint accounts and deploy tokens", async () => {
    let minBalance: number = await program.provider.connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    let tokenInitTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.createAccount({
        fromPubkey: defaultWallet.publicKey,
        newAccountPubkey: token1.publicKey,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
        lamports: minBalance
      }),
      anchor.web3.SystemProgram.createAccount({
        fromPubkey: defaultWallet.publicKey,
        newAccountPubkey: token2.publicKey,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
        lamports: minBalance
      }),
      createInitializeMintInstruction(token1.publicKey, 9, defaultWallet.publicKey, defaultWallet.publicKey),
      createInitializeMintInstruction(token2.publicKey, 0, defaultWallet.publicKey, defaultWallet.publicKey)
    );
    await provider.sendAndConfirm(tokenInitTx, [token1, token2]);
  });

  it("Mint some initial tokens", async () => {
    let creatorATA1 = await getAssociatedTokenAddress(token1.publicKey, campaignCreator.publicKey);
    let creatorATA2 = await getAssociatedTokenAddress(token2.publicKey, campaignCreator.publicKey);
    let mintTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        defaultWallet.publicKey,
        creatorATA1,
        campaignCreator.publicKey,
        token1.publicKey
      ),
      createAssociatedTokenAccountInstruction(
        defaultWallet.publicKey,
        creatorATA2,
        campaignCreator.publicKey,
        token2.publicKey
      ),
      createMintToInstruction(
        token1.publicKey,
        creatorATA1,
        defaultWallet.publicKey,
        1234000000000
      ),
      createMintToInstruction(
        token2.publicKey,
        creatorATA2,
        defaultWallet.publicKey,
        9999
      )
    );
    await provider.sendAndConfirm(mintTx, []);
    let balance1 = (await getAccount(connection, creatorATA1)).amount.toString();
    let balance2 = (await getAccount(connection, creatorATA2)).amount.toString();
    expect(balance1).to.equal("1234000000000");
    expect(balance2).to.equal("9999");
  });

  it("Initialize PlaylinkAirdrop platform", async () => {
    [airdropPlatform] = await PublicKey.findProgramAddress([anchor.utils.bytes.utf8.encode("airdrop_platform")], program.programId);
    await program.methods.initialize(new anchor.BN(700000000)).accounts({
      airdropPlatform,
      admin: admin.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId
    }).signers([admin]).rpc();
    let currentFeePerAsset = (await program.account.airdropPlatform.fetch(airdropPlatform)).feePerAsset;
    expect(currentFeePerAsset.toString()).to.equal("700000000");
  });

  it("Set operator", async () => {
    await program.methods.setOperators([operator.publicKey], [true]).accounts({
      airdropPlatform,
      admin: admin.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId
    }).signers([admin]).rpc();
    let operators = (await program.account.airdropPlatform.fetch(airdropPlatform)).operators;
    expect(operators.length).to.equal(2);
    expect(operators[0].toString()).to.equal(admin.publicKey.toString());
    expect(operators[1].toString()).to.equal(operator.publicKey.toString());
  });

  it("Update fee per asset", async () => {
    await program.methods.setFeePerAsset(new anchor.BN(100000000)).accounts({
      operator: operator.publicKey,
      airdropPlatform,
      systemProgram: anchor.web3.SystemProgram.programId
    }).signers([operator]).rpc();
    let currentFeePerAsset = (await program.account.airdropPlatform.fetch(airdropPlatform)).feePerAsset;
    expect(currentFeePerAsset.toString()).to.equal("100000000");
  });

  it("Create airdrop campaign", async () => {
    let now = ((await connection.getParsedAccountInfo(SYSVAR_CLOCK_PUBKEY)).value!.data as ParsedAccountData).parsed?.info?.unixTimestamp;
    let platformBalanceBefore = await connection.getBalance(airdropPlatform);
    await program.methods.createAirdropCampaign(
      "01BX5ZZKBKACTAV9WEVGEMMVRY",
      [{
        assetAddress: token1.publicKey,
        availableAmount: new anchor.BN(34000000000)
      }, {
        assetAddress: token2.publicKey,
        availableAmount: new anchor.BN(90)
      }],
      new anchor.BN(now + 30 * 60)
    ).accounts({
      airdropPlatform,
      campaignCreator: campaignCreator.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId
    }).signers([campaignCreator]).rpc();
    let campaigns: any = await (await program.account.airdropPlatform.fetch(airdropPlatform)).allCampaigns;
    let platformBalanceAfter = await connection.getBalance(airdropPlatform);
    expect(campaigns?.length).to.equal(1);
    expect(campaigns[0]?.campaignId).to.equal("01BX5ZZKBKACTAV9WEVGEMMVRY");
    expect(campaigns[0]?.creator?.toString()).to.equal(campaignCreator.publicKey.toString());
    expect(campaigns[0]?.assets?.length).to.equal(2);
    expect(campaigns[0]?.assets[0]?.assetAddress?.toString()).to.equal(token1.publicKey.toString());
    expect(campaigns[0]?.assets[0]?.availableAmount?.toString()).to.equal("34000000000");
    expect(campaigns[0]?.assets[1]?.assetAddress?.toString()).to.equal(token2.publicKey.toString());
    expect(campaigns[0]?.assets[1]?.availableAmount?.toString()).to.equal("90");
    expect(campaigns[0]?.startingTime?.toString()).to.equal((now + 30 * 60).toString());
    expect(campaigns[0]?.totalAvailableAssets?.toString()).to.equal("34000000090");
    expect(campaigns[0]?.airdropFee?.toString()).to.equal("200000000");
    expect((platformBalanceAfter - platformBalanceBefore).toString()).to.equal("200000000");
  });

  it("Approve assets", async () => {
    let creatorATA1 = await getAssociatedTokenAddress(token1.publicKey, campaignCreator.publicKey);
    let creatorATA2 = await getAssociatedTokenAddress(token2.publicKey, campaignCreator.publicKey);
    let approvalTx = new anchor.web3.Transaction().add(
      createApproveInstruction(
        creatorATA1,
        airdropPlatform,
        campaignCreator.publicKey,
        34000000000
      ),
      createApproveInstruction(
        creatorATA2,
        airdropPlatform,
        campaignCreator.publicKey,
        90
      )
    );
    await provider.sendAndConfirm(approvalTx, [campaignCreator]);
    let allowance1 = await getAccount(connection, creatorATA1);
    let allowance2 = await getAccount(connection, creatorATA2);
    expect(allowance1.delegate.toString()).to.equal(airdropPlatform.toString());
    expect(allowance1.delegatedAmount.toString()).to.equal("34000000000");
    expect(allowance2.delegate.toString()).to.equal(airdropPlatform.toString());
    expect(allowance2.delegatedAmount.toString()).to.equal("90");
  });

  it("Update airdrop campaign", async () => {
    let now = ((await connection.getParsedAccountInfo(SYSVAR_CLOCK_PUBKEY)).value!.data as ParsedAccountData).parsed?.info?.unixTimestamp;
    let platformBalanceBefore = await connection.getBalance(airdropPlatform);
    await program.methods.updateCampaign(
      "01BX5ZZKBKACTAV9WEVGEMMVRY",
      [{
        assetAddress: token1.publicKey,
        availableAmount: new anchor.BN(31000000000)
      }, {
        assetAddress: token2.publicKey,
        availableAmount: new anchor.BN(88)
      }, {
        assetAddress: token2.publicKey,
        availableAmount: new anchor.BN(1)
      }],
      new anchor.BN(now + 8)
    ).accounts({
      airdropPlatform,
      campaignCreator: campaignCreator.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId
    }).signers([campaignCreator]).rpc();
    let campaigns: any = (await program.account.airdropPlatform.fetch(airdropPlatform)).allCampaigns;
    let platformBalanceAfter = await connection.getBalance(airdropPlatform);
    expect(campaigns?.length).to.equal(1);
    expect(campaigns[0]?.assets?.length).to.equal(3);
    expect(campaigns[0]?.assets[0]?.assetAddress?.toString()).to.equal(token1.publicKey.toString());
    expect(campaigns[0]?.assets[0]?.availableAmount?.toString()).to.equal("31000000000");
    expect(campaigns[0]?.assets[1]?.assetAddress?.toString()).to.equal(token2.publicKey.toString());
    expect(campaigns[0]?.assets[1]?.availableAmount?.toString()).to.equal("88");
    expect(campaigns[0]?.assets[2]?.assetAddress?.toString()).to.equal(token2.publicKey.toString());
    expect(campaigns[0]?.assets[2]?.availableAmount?.toString()).to.equal("1");
    expect(campaigns[0]?.totalAvailableAssets?.toString()).to.equal("31000000089");
    expect((platformBalanceAfter - platformBalanceBefore).toString()).to.equal("100000000");
  });

  it("Airdrop", async () => {
    await sleep(10); // Wait until this campaign starts
    let creatorATA1 = await getAssociatedTokenAddress(token1.publicKey, campaignCreator.publicKey);
    let creatorATA2 = await getAssociatedTokenAddress(token2.publicKey, campaignCreator.publicKey);
    let participantATA1 = await getAssociatedTokenAddress(token1.publicKey, participant.publicKey);
    let participantATA2 = await getAssociatedTokenAddress(token2.publicKey, participant.publicKey);
    let airdropTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        operator.publicKey,
        participantATA1,
        participant.publicKey,
        token1.publicKey
      ),
      await program.methods.airdrop("01BX5ZZKBKACTAV9WEVGEMMVRY", new anchor.BN(0)).accounts({
        creatorAta: creatorATA1,
        recipientAta: participantATA1,
        mint: token1.publicKey,
        campaignCreator: campaignCreator.publicKey,
        operator: operator.publicKey,
        airdropPlatform,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      }).instruction(),
      createAssociatedTokenAccountInstruction(
        operator.publicKey,
        participantATA2,
        participant.publicKey,
        token2.publicKey
      ),
      await program.methods.airdrop("01BX5ZZKBKACTAV9WEVGEMMVRY", new anchor.BN(1)).accounts({
        creatorAta: creatorATA2,
        recipientAta: participantATA2,
        mint: token2.publicKey,
        campaignCreator: campaignCreator.publicKey,
        operator: operator.publicKey,
        airdropPlatform,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      }).instruction(),
      await program.methods.airdrop("01BX5ZZKBKACTAV9WEVGEMMVRY", new anchor.BN(2)).accounts({
        creatorAta: creatorATA2,
        recipientAta: participantATA2,
        mint: token2.publicKey,
        campaignCreator: campaignCreator.publicKey,
        operator: operator.publicKey,
        airdropPlatform,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      }).instruction()
    );
    await provider.sendAndConfirm(airdropTx, [operator]);
    let creatorBalance1 = (await getAccount(connection, creatorATA1)).amount.toString();
    let creatorBalance2 = (await getAccount(connection, creatorATA2)).amount.toString();
    let participantBalance1 = (await getAccount(connection, participantATA1)).amount.toString();
    let participantBalance2 = (await getAccount(connection, participantATA2)).amount.toString();
    let campaigns: any = (await program.account.airdropPlatform.fetch(airdropPlatform)).allCampaigns;
    expect(creatorBalance1).to.equal("1203000000000");
    expect(creatorBalance2).to.equal("9910");
    expect(participantBalance1).to.equal("31000000000");
    expect(participantBalance2).to.equal("89");
    expect(campaigns.length).to.equal(0);
  });

  it("Create another campaign", async () => {
    let now = ((await connection.getParsedAccountInfo(SYSVAR_CLOCK_PUBKEY)).value!.data as ParsedAccountData).parsed?.info?.unixTimestamp;
    await program.methods.createAirdropCampaign(
      "01BX5ZZKBKACTAV9WEVGEMMVRK",
      [{
        assetAddress: token1.publicKey,
        availableAmount: new anchor.BN(1234000)
      }, {
        assetAddress: token1.publicKey,
        availableAmount: new anchor.BN(4321000)
      }, {
        assetAddress: token2.publicKey,
        availableAmount: new anchor.BN(22)
      }],
      new anchor.BN(now + 2)
    ).accounts({
      airdropPlatform,
      campaignCreator: campaignCreator.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId
    }).signers([campaignCreator]).rpc();
    let campaigns: any = await (await program.account.airdropPlatform.fetch(airdropPlatform)).allCampaigns;
    expect(campaigns.length).to.equal(1);
    expect(campaigns[0]?.totalAvailableAssets?.toString()).to.equal("5555022");
  });

  it("Approve new assets", async () => {
    let creatorATA1 = await getAssociatedTokenAddress(token1.publicKey, campaignCreator.publicKey);
    let creatorATA2 = await getAssociatedTokenAddress(token2.publicKey, campaignCreator.publicKey);
    let approvalTx = new anchor.web3.Transaction().add(
      createApproveInstruction(
        creatorATA1,
        airdropPlatform,
        campaignCreator.publicKey,
        5555000
      ),
      createApproveInstruction(
        creatorATA2,
        airdropPlatform,
        campaignCreator.publicKey,
        22
      )
    );
    await provider.sendAndConfirm(approvalTx, [campaignCreator]);
    let allowance1 = await getAccount(connection, creatorATA1);
    let allowance2 = await getAccount(connection, creatorATA2);
    expect(allowance1.delegate.toString()).to.equal(airdropPlatform.toString());
    expect(allowance1.delegatedAmount.toString()).to.equal("5555000");
    expect(allowance2.delegate.toString()).to.equal(airdropPlatform.toString());
    expect(allowance2.delegatedAmount.toString()).to.equal("22");
  });

  it("Airdrop", async () => {
    await sleep(3);
    let creatorATA1 = await getAssociatedTokenAddress(token1.publicKey, campaignCreator.publicKey);
    let creatorATA2 = await getAssociatedTokenAddress(token2.publicKey, campaignCreator.publicKey);
    let participantATA1 = await getAssociatedTokenAddress(token1.publicKey, participant.publicKey);
    let participantATA2 = await getAssociatedTokenAddress(token2.publicKey, participant.publicKey);
    let airdropTx = new anchor.web3.Transaction().add(
      await program.methods.airdrop("01BX5ZZKBKACTAV9WEVGEMMVRK", new anchor.BN(0)).accounts({
        creatorAta: creatorATA1,
        recipientAta: participantATA1,
        mint: token1.publicKey,
        campaignCreator: campaignCreator.publicKey,
        operator: operator.publicKey,
        airdropPlatform,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      }).instruction(),
      await program.methods.airdrop("01BX5ZZKBKACTAV9WEVGEMMVRK", new anchor.BN(2)).accounts({
        creatorAta: creatorATA2,
        recipientAta: participantATA2,
        mint: token2.publicKey,
        campaignCreator: campaignCreator.publicKey,
        operator: operator.publicKey,
        airdropPlatform,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      }).instruction()
    );
    await provider.sendAndConfirm(airdropTx, [operator]);
    let campaigns: any = await (await program.account.airdropPlatform.fetch(airdropPlatform)).allCampaigns;
    expect(campaigns.length).to.equal(1);
    expect(campaigns[0]?.totalAvailableAssets?.toString()).to.equal("4321000");
  });

  it("Admin withdraws airdrop fee", async () => {
    await program.methods.withdrawAirdropFee().accounts({
      recipient: recipient.publicKey,
      admin: admin.publicKey,
      airdropPlatform,
      systemProgram: anchor.web3.SystemProgram.programId
    }).signers([admin]).rpc();
    let airdropPlatformBalance = await connection.getBalance(airdropPlatform);
    expect(airdropPlatformBalance.toString()).to.equal("0");
  });
});

let sleep = (seconds: number) => {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
};