//! Signature checks for signed messages (attestations, quotes) on Solana.
//!
//! Programs can't verify Ed25519 signatures cheaply themselves. Instead the transaction includes
//! an instruction to the native Ed25519 program, which fails the whole transaction if the
//! signature is invalid. The program then reads that instruction through the instructions sysvar
//! and checks it covers exactly the expected signer and message (docs/SPECIFICATION.md Section 7).

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

/// Address of the instructions sysvar, for `#[account(address = ...)]` checks.
pub use solana_sdk_ids::sysvar::instructions::ID as INSTRUCTIONS_SYSVAR_ID;

#[error_code]
pub enum SignatureError {
    #[msg("the previous instruction must be an Ed25519 signature check")]
    MissingSignature,
    #[msg("the Ed25519 instruction must check exactly one signature, with its data inline")]
    MalformedSignature,
    #[msg("the signature is not by the expected key")]
    WrongSigner,
    #[msg("the signed message is not the expected message")]
    WrongMessage,
}

// Layout of the Ed25519 program's instruction data: a count, one padding byte, then one
// 14-byte offsets record per signature (seven little-endian u16 values).
const HEADER: usize = 2;
const OFFSETS: usize = 14;
/// `instruction_index` value meaning "in this same instruction".
const THIS_INSTRUCTION: u16 = u16::MAX;

fn u16_at(data: &[u8], at: usize) -> Result<u16> {
    let bytes = data
        .get(at..at + 2)
        .ok_or(SignatureError::MalformedSignature)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

/// Require that the instruction just before the current one verified `signer`'s Ed25519
/// signature over exactly `message`.
pub fn require_signed(instructions: &AccountInfo, signer: &Pubkey, message: &[u8]) -> Result<()> {
    let current = load_current_index_checked(instructions)
        .map_err(|_| error!(SignatureError::MissingSignature))?;
    require!(current > 0, SignatureError::MissingSignature);
    let ix = load_instruction_at_checked(usize::from(current - 1), instructions)
        .map_err(|_| error!(SignatureError::MissingSignature))?;
    require!(
        ix.program_id == solana_sdk_ids::ed25519_program::ID,
        SignatureError::MissingSignature
    );
    check_ed25519_data(&ix.data, signer, message)
}

/// Check one Ed25519 instruction's data: one signature, all fields inline, by `signer` over
/// exactly `message`. Separate from `require_signed` so it can be unit-tested.
pub fn check_ed25519_data(data: &[u8], signer: &Pubkey, message: &[u8]) -> Result<()> {
    require!(
        data.len() >= HEADER + OFFSETS && data[0] == 1,
        SignatureError::MalformedSignature
    );
    let field = |i: usize| u16_at(data, HEADER + 2 * i);
    let (sig_ix, key_at, key_ix, msg_at, msg_len, msg_ix) = (
        field(1)?,
        field(2)?,
        field(3)?,
        field(4)?,
        field(5)?,
        field(6)?,
    );
    // Every part must be in this instruction, or another instruction could supply it.
    require!(
        sig_ix == THIS_INSTRUCTION && key_ix == THIS_INSTRUCTION && msg_ix == THIS_INSTRUCTION,
        SignatureError::MalformedSignature
    );
    let key = data
        .get(usize::from(key_at)..usize::from(key_at) + 32)
        .ok_or(SignatureError::MalformedSignature)?;
    require!(key == signer.as_ref(), SignatureError::WrongSigner);
    let signed = data
        .get(usize::from(msg_at)..usize::from(msg_at) + usize::from(msg_len))
        .ok_or(SignatureError::MalformedSignature)?;
    require!(signed == message, SignatureError::WrongMessage);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ed25519 instruction data with one inline signature record. The signature bytes don't
    /// matter here: the Ed25519 program checks them, this crate checks what they cover.
    fn data(key: &Pubkey, message: &[u8], index: u16) -> Vec<u8> {
        let (key_at, sig_at, msg_at) = (16u16, 48u16, 112u16);
        let mut d = vec![1u8, 0];
        for v in [
            sig_at,
            index,
            key_at,
            index,
            msg_at,
            message.len() as u16,
            index,
        ] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(key.as_ref());
        d.extend_from_slice(&[0u8; 64]);
        d.extend_from_slice(message);
        d
    }

    fn code(result: Result<()>) -> String {
        result.unwrap_err().to_string()
    }

    #[test]
    fn accepts_the_expected_signer_and_message() {
        let key = Pubkey::new_unique();
        assert!(
            check_ed25519_data(&data(&key, b"quote", THIS_INSTRUCTION), &key, b"quote").is_ok()
        );
    }

    #[test]
    fn rejects_another_signer_or_message() {
        let key = Pubkey::new_unique();
        let d = data(&key, b"quote", THIS_INSTRUCTION);
        assert!(
            code(check_ed25519_data(&d, &Pubkey::new_unique(), b"quote")).contains("WrongSigner")
        );
        assert!(code(check_ed25519_data(&d, &key, b"quotE")).contains("WrongMessage"));
        // A prefix of the signed bytes is not the signed message.
        assert!(code(check_ed25519_data(&d, &key, b"quo")).contains("WrongMessage"));
    }

    #[test]
    fn rejects_parts_taken_from_another_instruction() {
        let key = Pubkey::new_unique();
        let d = data(&key, b"quote", 0);
        assert!(code(check_ed25519_data(&d, &key, b"quote")).contains("MalformedSignature"));
    }

    #[test]
    fn rejects_zero_or_several_signatures_and_truncated_data() {
        let key = Pubkey::new_unique();
        let mut d = data(&key, b"quote", THIS_INSTRUCTION);
        d[0] = 2;
        assert!(code(check_ed25519_data(&d, &key, b"quote")).contains("MalformedSignature"));
        let d = data(&key, b"quote", THIS_INSTRUCTION);
        assert!(code(check_ed25519_data(&d[..20], &key, b"quote")).contains("MalformedSignature"));
        assert!(code(check_ed25519_data(&[], &key, b"quote")).contains("MalformedSignature"));
    }
}
