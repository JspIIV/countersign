// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    ISignatureValidator,
    ValidationResult,
    VALIDATION_SUCCESS,
    VALIDATION_FAILURE
} from "nitrolite/src/interfaces/ISignatureValidator.sol";
import {ChannelDefinition, ChannelStatus, State, StateIntent} from "nitrolite/src/interfaces/Types.sol";
import {Utils} from "nitrolite/src/Utils.sol";

/// The ChannelHub calls a validator with exactly these reads available; nothing in Nitrolite is changed.
interface IChannelHub {
    function NODE() external view returns (address);
    function DEFAULT_SIG_VALIDATOR() external view returns (ISignatureValidator);
    function getChannelData(bytes32 channelId)
        external
        view
        returns (
            ChannelStatus status,
            ChannelDefinition memory definition,
            State memory lastState,
            uint256 challengeExpiry,
            uint256 lockedFunds
        );
}

/**
 * @title Countersign
 * @notice Internet Court as a Nitrolite (Yellow) signature validator.
 *
 * A Nitrolite state is enforceable on chain only when both the user and the node have signed it, and every signature
 * names its validator in its first byte. A channel that sets this validator's bit in approvedSignatureValidators
 * accepts, in place of a party's own signature, the countersignature of a GenLayer court that has ruled that the party
 * owes exactly that state under terms both parties signed.
 *
 * The flow:
 *   1. The parties sign a state whose metadata is keccak256 of their terms: a JSON agreement naming a question, the
 *      https sources that settle it, and the user's share of the channel's funds for each answer.
 *   2. When the session ends, one party signs the settlement it claims the terms give it. If the other refuses,
 *      anybody files the case here: the signed anchor, the signed settlement and the terms.
 *   3. The court reads the sources, finds the answer, and countersigns only if the settlement gives the user exactly
 *      the share the terms name for it. The ruling lands here through the court's Ghost, with no relayer.
 *   4. The settlement is submitted to the ChannelHub with the refusing party's signature set to
 *      [validator id][abi.encode(caseId)]. The hub asks this contract, which says yes for that state, that channel and
 *      that party, and nothing else.
 *
 * What the court can never do: sign for a channel that did not approve this validator (the hub checks the bitmask),
 * sign a state other than the one it ruled on, sign for the party who proposed it, or sign a challenge.
 */
contract Countersign is ISignatureValidator {
    enum Verdict {
        NONE,
        FILED,
        SIGNED,
        REFUSED
    }

    struct Case {
        bytes32 channelId;
        bytes32 stateHash; // keccak256 of the settlement's signing data
        bytes32 termsHash;
        address proposer;
        address respondent; // the party the court may sign for
        address token;
        uint64 anchorVersion;
        uint64 version;
        uint8 decimals;
        StateIntent intent; // OPERATE or CLOSE
        Verdict verdict;
        uint64 filedAt;
        uint256 anchorUserShare; // the user's share of the channel's funds in the anchor
        uint256 proposedUserShare; // the user's share if the settlement is enforced
        uint256 total; // the channel's funds in the anchor
        bytes32 reason;
    }

    uint256 public constant MAX_TERMS = 4000;

    IChannelHub public immutable HUB;
    address public immutable DEPLOYER;
    address public court;

    Case[] private _cases;
    mapping(uint256 => string) private _terms;
    // keccak256(channelId, stateHash, respondent) => case id + 1: a settlement is judged once per channel and respondent.
    // The channel is part of the key because a state's signing data does not name its channel: two channels on the same
    // terms produce identical settlements, and without the channel one could be filed first to block the other forever.
    mapping(bytes32 => uint256) private _filed;

    event CourtSet(address court);
    event CaseFiled(uint256 indexed caseId, bytes32 indexed channelId, address proposer, address respondent, bytes32 stateHash);
    event CaseRuled(uint256 indexed caseId, bool signed, bytes32 reason);

    error OnlyDeployer();
    error OnlyCourt();
    error CourtAlreadySet();
    error ChannelNotOpen();
    error TermsTooLong();
    error TermsMismatch();
    error AnchorNotSigned();
    error IncorrectSettlement();
    error AlreadySignedByBoth();
    error NoProposerSignature();
    error SharesDoNotAddUp();
    error AlreadyFiled(uint256 caseId);
    error NoSuchCase();
    error AlreadyRuled();

    constructor(IChannelHub hub) {
        HUB = hub;
        DEPLOYER = msg.sender;
    }

    /// One time wiring to the court Intelligent Contract's address (its Ghost on GenLayer Chain).
    function setCourt(address court_) external {
        if (msg.sender != DEPLOYER) revert OnlyDeployer();
        if (court != address(0)) revert CourtAlreadySet();
        court = court_;
        emit CourtSet(court_);
    }

    // ------------------------------------------------------------------ filing

    /**
     * @notice File a settlement one party signed and the other refuses to sign. Open to anybody.
     * @param channelId An open ChannelHub channel
     * @param anchor A state both parties signed (default ECDSA validator) whose metadata is keccak256(terms)
     * @param settlement The OPERATE or CLOSE state the proposer signed, newer than the anchor, under the same terms
     * @param terms The agreement text the anchor commits to
     */
    function fileCase(bytes32 channelId, State calldata anchor, State calldata settlement, string calldata terms)
        external
        returns (uint256 caseId)
    {
        (ChannelStatus status, ChannelDefinition memory def,,,) = HUB.getChannelData(channelId);
        if (status != ChannelStatus.OPERATING && status != ChannelStatus.DISPUTED) revert ChannelNotOpen();
        if (bytes(terms).length > MAX_TERMS) revert TermsTooLong();
        if (keccak256(bytes(terms)) != anchor.metadata) revert TermsMismatch();

        address node = HUB.NODE();
        if (!_ecdsa(channelId, anchor, anchor.userSig, def.user) || !_ecdsa(channelId, anchor, anchor.nodeSig, node)) {
            revert AnchorNotSigned();
        }

        if (
            (settlement.intent != StateIntent.OPERATE && settlement.intent != StateIntent.CLOSE)
                || settlement.version <= anchor.version || settlement.metadata != anchor.metadata
                || settlement.homeLedger.token != anchor.homeLedger.token
                || settlement.homeLedger.decimals != anchor.homeLedger.decimals
        ) revert IncorrectSettlement();

        bool byUser = _ecdsa(channelId, settlement, settlement.userSig, def.user);
        bool byNode = _ecdsa(channelId, settlement, settlement.nodeSig, node);
        if (byUser && byNode) revert AlreadySignedByBoth();
        if (!byUser && !byNode) revert NoProposerSignature();

        uint256 total = anchor.homeLedger.userAllocation + anchor.homeLedger.nodeAllocation;
        uint256 share;
        if (settlement.intent == StateIntent.OPERATE) {
            share = settlement.homeLedger.userAllocation;
            if (settlement.homeLedger.userNetFlow != anchor.homeLedger.userNetFlow) revert IncorrectSettlement();
        } else {
            // A CLOSE pays out the change in net flows since the anchor; it is enforceable only on top of the anchor.
            int256 toUser = anchor.homeLedger.userNetFlow - settlement.homeLedger.userNetFlow;
            int256 toNode = anchor.homeLedger.nodeNetFlow - settlement.homeLedger.nodeNetFlow;
            if (toUser < 0 || toNode < 0 || uint256(toUser) + uint256(toNode) != total) revert SharesDoNotAddUp();
            share = uint256(toUser);
        }

        bytes32 stateHash = keccak256(Utils.toSigningData(settlement));
        address respondent = byUser ? node : def.user;
        bytes32 key = keccak256(abi.encode(channelId, stateHash, respondent));
        if (_filed[key] != 0) revert AlreadyFiled(_filed[key] - 1);

        caseId = _cases.length;
        _cases.push(
            Case({
                channelId: channelId,
                stateHash: stateHash,
                termsHash: anchor.metadata,
                proposer: byUser ? def.user : node,
                respondent: respondent,
                token: anchor.homeLedger.token,
                anchorVersion: anchor.version,
                version: settlement.version,
                decimals: anchor.homeLedger.decimals,
                intent: settlement.intent,
                verdict: Verdict.FILED,
                filedAt: uint64(block.timestamp),
                anchorUserShare: anchor.homeLedger.userAllocation,
                proposedUserShare: share,
                total: total,
                reason: bytes32(0)
            })
        );
        _terms[caseId] = terms;
        _filed[key] = caseId + 1;
        emit CaseFiled(caseId, channelId, byUser ? def.user : node, respondent, stateHash);
    }

    /// The court's verdict, through its Ghost. Final: a refused settlement is never signed later.
    function rule(uint256 caseId, bool sign, bytes32 reason) external {
        if (msg.sender != court || court == address(0)) revert OnlyCourt();
        if (caseId >= _cases.length) revert NoSuchCase();
        Case storage c = _cases[caseId];
        if (c.verdict != Verdict.FILED) revert AlreadyRuled();
        c.verdict = sign ? Verdict.SIGNED : Verdict.REFUSED;
        c.reason = reason;
        emit CaseRuled(caseId, sign, reason);
    }

    // ------------------------------------------------------------------ ISignatureValidator

    /// @dev signature = abi.encode(caseId). Valid only for the ruled state, its channel and the respondent; a CLOSE is
    ///      valid only while the channel's last enforced state is still the anchor, so the payout is exactly the one judged.
    function validateSignature(bytes32 channelId, bytes calldata signingData, bytes calldata signature, address participant)
        external
        view
        returns (ValidationResult)
    {
        if (signature.length != 32) return VALIDATION_FAILURE;
        uint256 caseId = abi.decode(signature, (uint256));
        if (caseId >= _cases.length) return VALIDATION_FAILURE;
        Case storage c = _cases[caseId];
        if (
            c.verdict != Verdict.SIGNED || c.channelId != channelId || c.respondent != participant
                || c.stateHash != keccak256(signingData)
        ) return VALIDATION_FAILURE;
        if (c.intent == StateIntent.CLOSE) {
            (, , State memory last,,) = HUB.getChannelData(channelId);
            if (last.version != c.anchorVersion) return VALIDATION_FAILURE;
        }
        return VALIDATION_SUCCESS;
    }

    /// The court never starts a challenge for anybody.
    function validateChallengeSignature(bytes32, bytes calldata, bytes calldata, address)
        external
        pure
        returns (ValidationResult)
    {
        return VALIDATION_FAILURE;
    }

    // ------------------------------------------------------------------ reads

    function caseCount() external view returns (uint256) {
        return _cases.length;
    }

    function getCase(uint256 caseId) external view returns (Case memory) {
        if (caseId >= _cases.length) revert NoSuchCase();
        return _cases[caseId];
    }

    /// What the court reads: (channel, proposer, respondent, proposer is the user, decimals, anchor share, proposed
    /// share, total, intent, verdict).
    function facts(uint256 caseId)
        external
        view
        returns (bytes32, address, address, bool, uint256, uint256, uint256, uint256, uint256, uint256)
    {
        if (caseId >= _cases.length) revert NoSuchCase();
        Case storage c = _cases[caseId];
        (, ChannelDefinition memory def,,,) = HUB.getChannelData(c.channelId);
        return (
            c.channelId,
            c.proposer,
            c.respondent,
            c.proposer == def.user,
            uint256(c.decimals),
            c.anchorUserShare,
            c.proposedUserShare,
            c.total,
            uint256(c.intent),
            uint256(c.verdict)
        );
    }

    function termsOf(uint256 caseId) external view returns (string memory) {
        if (caseId >= _cases.length) revert NoSuchCase();
        return _terms[caseId];
    }

    // ------------------------------------------------------------------ internal

    /// A signature made with the hub's default ECDSA validator (first byte 0x00) by `who` over `s` in this channel.
    function _ecdsa(bytes32 channelId, State calldata s, bytes calldata sig, address who) internal view returns (bool) {
        if (sig.length < 2 || uint8(sig[0]) != 0) return false;
        ValidationResult r = HUB.DEFAULT_SIG_VALIDATOR().validateSignature(channelId, Utils.toSigningData(s), sig[1:], who);
        return ValidationResult.unwrap(r) != ValidationResult.unwrap(VALIDATION_FAILURE);
    }
}
