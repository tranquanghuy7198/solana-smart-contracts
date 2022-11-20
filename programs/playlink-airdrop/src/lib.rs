use anchor_lang::prelude::*;
use anchor_lang::{
    solana_program::{clock, program::invoke_signed},
    system_program,
};
use anchor_spl::token::{Mint, Token, TokenAccount};

declare_id!("HWTkSSJhPQfipAd6QBkXPSypwz1tqBXDXpkdmkxNDcUJ");

#[program]
pub mod playlink_airdrop {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, fee_per_asset: u64) -> Result<()> {
        let airdrop_platform = &mut ctx.accounts.airdrop_platform;
        airdrop_platform.admin = ctx.accounts.admin.key();
        airdrop_platform.fee_per_asset = fee_per_asset;
        airdrop_platform.operators.push(ctx.accounts.admin.key());
        airdrop_platform.bump = *ctx.bumps.get("airdrop_platform").unwrap();
        Ok(())
    }

    pub fn set_operators(
        ctx: Context<SetOperators>,
        operators: Vec<Pubkey>,
        is_operators: Vec<bool>,
    ) -> Result<()> {
        // Validate data
        require!(
            operators.len() == is_operators.len(),
            PlaylinkAirdropErr::LengthsMismatch
        );

        // Add or remove operators
        for (i, new_operator) in operators.iter().enumerate() {
            if *is_operators.get(i).unwrap() {
                ctx.accounts
                    .airdrop_platform
                    .operators
                    .push(new_operator.key());
            } else {
                ctx.accounts
                    .airdrop_platform
                    .operators
                    .retain(|op| op.key() != new_operator.key());
            }
        }
        Ok(())
    }

    pub fn set_fee_per_asset(ctx: Context<SetFeePerAsset>, new_fee: u64) -> Result<()> {
        ctx.accounts.airdrop_platform.fee_per_asset = new_fee;
        Ok(())
    }

    pub fn create_airdrop_campaign(
        ctx: Context<CreateAirdropCampaign>,
        campaign_id: String,
        assets: Vec<Asset>,
        starting_time: u64,
    ) -> Result<()> {
        // Check if campaign exists
        require!(
            ctx.accounts
                .airdrop_platform
                .all_campaigns
                .iter()
                .all(|c| c.campaign_id != campaign_id),
            PlaylinkAirdropErr::CampaignAlreadyCreated
        );

        // Withdraw airdrop fee from campaign creator's wallet
        let airdrop_fee = ctx.accounts.airdrop_platform.fee_per_asset * assets.len() as u64;
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.campaign_creator.to_account_info(),
                    to: ctx.accounts.airdrop_platform.to_account_info(),
                },
            ),
            airdrop_fee,
        )?;

        // Validate data
        require!(
            (clock::Clock::get().unwrap().unix_timestamp as u64) < starting_time,
            PlaylinkAirdropErr::LowStartingTime
        );

        // Create new airdrop campaign
        ctx.accounts
            .airdrop_platform
            .all_campaigns
            .push(AirdropCampaign {
                campaign_id: campaign_id.clone(),
                creator: ctx.accounts.campaign_creator.key(),
                assets: assets.clone(),
                starting_time,
                total_available_assets: assets.iter().map(|asset| asset.available_amount).sum(),
                airdrop_fee,
            });

        emit!(AirdropCampaignCreated {
            campaign_id,
            creator: ctx.accounts.campaign_creator.key(),
            assets: assets.clone(),
            starting_time
        });

        Ok(())
    }

    pub fn update_campaign(
        ctx: Context<UpdateCampaign>,
        campaign_id: String,
        assets: Vec<Asset>,
        starting_time: u64,
    ) -> Result<()> {
        let new_airdrop_fee = ctx.accounts.airdrop_platform.fee_per_asset * assets.len() as u64;
        let airdrop_platform = ctx.accounts.airdrop_platform.to_account_info();

        // Make sure that this campaign exist
        require!(
            ctx.accounts
                .airdrop_platform
                .all_campaigns
                .iter()
                .any(|c| c.campaign_id == campaign_id),
            PlaylinkAirdropErr::CampaignNotExists
        );

        // Only campaign creator can update
        let campaign = ctx
            .accounts
            .airdrop_platform
            .all_campaigns
            .iter_mut()
            .find(|c| c.campaign_id == campaign_id)
            .unwrap();
        require!(
            ctx.accounts.campaign_creator.key() == campaign.creator,
            PlaylinkAirdropErr::NotCampaignCreator
        );

        // Make sure that this campaign has not started yet
        require!(
            (clock::Clock::get().unwrap().unix_timestamp as u64) < campaign.starting_time,
            PlaylinkAirdropErr::UpdateNotAllowed
        );

        // Check airdrop fee and withdraw more if necessary
        if new_airdrop_fee > campaign.airdrop_fee {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.campaign_creator.to_account_info(),
                        to: airdrop_platform,
                    },
                ),
                new_airdrop_fee - campaign.airdrop_fee,
            )?;
        }

        // Validate data
        require!(
            (clock::Clock::get().unwrap().unix_timestamp as u64) < starting_time,
            PlaylinkAirdropErr::LowStartingTime
        );

        // Update campaign info
        campaign.assets = assets.clone();
        campaign.starting_time = starting_time;
        campaign.total_available_assets = assets.iter().map(|asset| asset.available_amount).sum();
        campaign.airdrop_fee = new_airdrop_fee;

        emit!(AirdropCampaignUpdated {
            campaign_id,
            creator: campaign.creator.key(),
            assets: assets.clone(),
            starting_time
        });

        Ok(())
    }

    pub fn airdrop(ctx: Context<Airdrop>, campaign_id: String, asset_index: u64) -> Result<()> {
        let airdrop_platform = ctx.accounts.airdrop_platform.clone();

        // Make sure that the campaign exists
        require!(
            ctx.accounts
                .airdrop_platform
                .all_campaigns
                .iter()
                .any(|c| c.campaign_id == campaign_id
                    && c.creator == ctx.accounts.campaign_creator.key()),
            PlaylinkAirdropErr::CampaignNotExists
        );

        // Get the corresponding campaign
        let campaign = ctx
            .accounts
            .airdrop_platform
            .all_campaigns
            .iter_mut()
            .find(|c| {
                c.campaign_id == campaign_id && c.creator == ctx.accounts.campaign_creator.key()
            })
            .unwrap();

        // Make sure that this campaign has started
        require!(
            (clock::Clock::get().unwrap().unix_timestamp as u64) >= campaign.starting_time,
            PlaylinkAirdropErr::CampaignNotStarts
        );

        // Find corresponding assets
        require!(
            asset_index < campaign.assets.len() as u64,
            PlaylinkAirdropErr::InvalidAssetIndex
        );
        let asset = campaign.assets.get_mut(asset_index as usize).unwrap();
        require!(
            asset.asset_address == ctx.accounts.mint.key(),
            PlaylinkAirdropErr::AssetAddressMismatch
        );

        // Airdrop - PDA signs by seeds and bump
        invoke_signed(
            &spl_token::instruction::transfer(
                &spl_token::ID,
                ctx.accounts.creator_ata.to_account_info().key,
                ctx.accounts.recipient_ata.to_account_info().key,
                &airdrop_platform.key(),
                &[&airdrop_platform.key()],
                asset.available_amount,
            )?,
            &[
                ctx.accounts.creator_ata.to_account_info(),
                ctx.accounts.recipient_ata.to_account_info(),
                airdrop_platform.to_account_info(),
            ],
            &[&[b"airdrop_platform", &[airdrop_platform.bump]]],
        )?;

        // Update status
        campaign.total_available_assets -= asset.available_amount;
        asset.available_amount = 0;

        // Remove campaign if all assets are airdropped
        if campaign.total_available_assets == 0 {
            ctx.accounts
                .airdrop_platform
                .all_campaigns
                .retain(|c| c.campaign_id != campaign_id);
        }

        Ok(())
    }

    pub fn withdraw_airdrop_fee(ctx: Context<WithdrawAirdropFee>) -> Result<()> {
        let amount = ctx.accounts.airdrop_platform.to_account_info().lamports();
        **ctx
            .accounts
            .airdrop_platform
            .to_account_info()
            .try_borrow_mut_lamports()? -= amount;
        **ctx
            .accounts
            .recipient
            .to_account_info()
            .try_borrow_mut_lamports()? += amount;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        seeds = [b"airdrop_platform"],
        bump,
        payer = admin,
        space = 9000
    )]
    pub airdrop_platform: Account<'info, AirdropPlatform>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetOperators<'info> {
    #[account(mut, constraint = admin.key() == airdrop_platform.admin.key())]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"airdrop_platform"], bump = airdrop_platform.bump)]
    pub airdrop_platform: Account<'info, AirdropPlatform>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetFeePerAsset<'info> {
    #[account(constraint = airdrop_platform.operators.iter().any(|op| op.key() == operator.key()))]
    pub operator: Signer<'info>,
    #[account(mut, seeds = [b"airdrop_platform"], bump = airdrop_platform.bump)]
    pub airdrop_platform: Account<'info, AirdropPlatform>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateAirdropCampaign<'info> {
    #[account(mut, seeds = [b"airdrop_platform"], bump = airdrop_platform.bump)]
    pub airdrop_platform: Account<'info, AirdropPlatform>,
    #[account(mut)]
    pub campaign_creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateCampaign<'info> {
    #[account(mut, seeds = [b"airdrop_platform"], bump = airdrop_platform.bump)]
    pub airdrop_platform: Account<'info, AirdropPlatform>,
    #[account(mut)]
    pub campaign_creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Airdrop<'info> {
    #[account(mut, token::mint = mint, token::authority = campaign_creator)]
    pub creator_ata: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub recipient_ata: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    /// CHECK: This is safe because we never change its content
    pub campaign_creator: AccountInfo<'info>,
    #[account(constraint = airdrop_platform.operators.iter().any(|op| op.key() == operator.key()))]
    pub operator: Signer<'info>,
    #[account(mut, seeds = [b"airdrop_platform"], bump = airdrop_platform.bump)]
    pub airdrop_platform: Account<'info, AirdropPlatform>,
    pub rent: Sysvar<'info, Rent>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawAirdropFee<'info> {
    /// CHECK: This is safe
    #[account(mut)]
    pub recipient: AccountInfo<'info>,
    #[account(mut, constraint = admin.key() == airdrop_platform.admin.key())]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"airdrop_platform"], bump = airdrop_platform.bump)]
    pub airdrop_platform: Account<'info, AirdropPlatform>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Asset {
    asset_address: Pubkey,
    available_amount: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct AirdropCampaign {
    campaign_id: String,
    creator: Pubkey,
    assets: Vec<Asset>,
    starting_time: u64,
    total_available_assets: u64,
    airdrop_fee: u64,
}

#[account]
#[derive(Default)]
pub struct AirdropPlatform {
    admin: Pubkey,
    fee_per_asset: u64,
    all_campaigns: Vec<AirdropCampaign>,
    operators: Vec<Pubkey>,
    bump: u8,
}

#[error_code]
pub enum PlaylinkAirdropErr {
    #[msg("PlaylinkAirdrop: lengths mismatch")]
    LengthsMismatch,

    #[msg("PlaylinkAirdrop: campaign already created")]
    CampaignAlreadyCreated,

    #[msg("PlaylinkAirdrop: starting time too low")]
    LowStartingTime,

    #[msg("PlaylinkAirdrop: caller is not campaign owner")]
    NotCampaignCreator,

    #[msg("PlaylinkAirdrop: campaign started, cannot update campaign")]
    UpdateNotAllowed,

    #[msg("PlaylinkAirdrop: campaign does not exist")]
    CampaignNotExists,

    #[msg("PlaylinkAirdrop: campaign not start yet")]
    CampaignNotStarts,

    #[msg("PlaylinkAirdrop: invalid asset index")]
    InvalidAssetIndex,

    #[msg("PlaylinkAirdrop: asset address mismatch")]
    AssetAddressMismatch,
}

#[event]
pub struct AirdropCampaignCreated {
    campaign_id: String,
    creator: Pubkey,
    assets: Vec<Asset>,
    starting_time: u64,
}

#[event]
pub struct AirdropCampaignUpdated {
    campaign_id: String,
    creator: Pubkey,
    assets: Vec<Asset>,
    starting_time: u64,
}
