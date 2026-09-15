import {
  encodeFunctionData,
  hashTypedData,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { POLYGON_CHAIN_ID, POLYGON_USDT_ADDRESS } from './config.js'

export const tokenAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'getNonce',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: 'nonce', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getChainId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getDomainSeperator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'ERC712_VERSION',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'executeMetaTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'userAddress', type: 'address' },
      { name: 'functionSignature', type: 'bytes' },
      { name: 'sigR', type: 'bytes32' },
      { name: 'sigS', type: 'bytes32' },
      { name: 'sigV', type: 'uint8' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
] as const

export const metaTransactionTypes = {
  MetaTransaction: [
    { name: 'nonce', type: 'uint256' },
    { name: 'from', type: 'address' },
    { name: 'functionSignature', type: 'bytes' },
  ],
} as const

export function metaTransactionDomain() {
  return {
    name: 'USDT0',
    version: '1',
    verifyingContract: POLYGON_USDT_ADDRESS,
    salt: toHex(BigInt(POLYGON_CHAIN_ID), { size: 32 }),
  } as const
}

export function encodeTransfer(recipient: Address, amountRaw: bigint): Hex {
  return encodeFunctionData({
    abi: tokenAbi,
    functionName: 'transfer',
    args: [recipient, amountRaw],
  })
}

export function metaTransactionDigest(userAddress: Address, nonce: bigint, functionSignature: Hex): Hex {
  return hashTypedData({
    domain: metaTransactionDomain(),
    types: metaTransactionTypes,
    primaryType: 'MetaTransaction',
    message: { nonce, from: userAddress, functionSignature },
  })
}

export function splitSignature(signature: unknown) {
  if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) {
    throw new Error('signature must be a 65-byte hex signature.')
  }

  const r = `0x${signature.slice(2, 66)}` as Hex
  const s = `0x${signature.slice(66, 130)}` as Hex
  const rawV = Number.parseInt(signature.slice(130, 132), 16)
  const v = rawV < 27 ? rawV + 27 : rawV

  if (v !== 27 && v !== 28) throw new Error('signature has an unsupported recovery byte.')
  return { r, s, v } as const
}

export function encodeMetaTransaction(
  userAddress: Address,
  functionSignature: Hex,
  signature: unknown,
): Hex {
  const { r, s, v } = splitSignature(signature)
  return encodeFunctionData({
    abi: tokenAbi,
    functionName: 'executeMetaTransaction',
    args: [userAddress, functionSignature, r, s, v],
  })
}
