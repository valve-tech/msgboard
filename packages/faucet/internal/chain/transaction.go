package chain

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

type TxBuilder interface {
	Sender() common.Address
	Transfer(ctx context.Context, to string, value *big.Int) (common.Hash, error)
}

type TxBuild struct {
	client      bind.ContractTransactor
	privateKey  *ecdsa.PrivateKey
	signer      types.Signer
	fromAddress common.Address
}

func NewTxBuilder(provider string, privateKey *ecdsa.PrivateKey, chainID *big.Int) (TxBuilder, error) {
	client, err := ethclient.Dial(provider)
	if err != nil {
		return nil, errors.New("unable to contact provider")
	}

	if chainID == nil {
		chainID, err = client.ChainID(context.Background())
		if err != nil {
			return nil, err
		}
	}

	return &TxBuild{
		client:      client,
		privateKey:  privateKey,
		signer:      types.NewEIP155Signer(chainID),
		fromAddress: crypto.PubkeyToAddress(privateKey.PublicKey),
	}, nil
}

func (b *TxBuild) Sender() common.Address {
	return b.fromAddress
}

// dynamicGasPrice derives a legacy gas price from the chain's REAL base fee — deliberately
// NOT the node's SuggestGasPrice, which on PulseChain (943/369) returns a bogus ~100k-gwei
// quote that makes transfers underprice and stick in the mempool (the 3-week faucet outage).
// baseFee*2 + a priority floor that actually clears validators (943 confirms at ~0.03–5 gwei).
func (b *TxBuild) dynamicGasPrice(ctx context.Context) (*big.Int, error) {
	const priorityFloorWei = 2_000_000_000 // 2 gwei
	head, err := b.client.HeaderByNumber(ctx, nil)
	if err != nil {
		return nil, err
	}
	floor := big.NewInt(priorityFloorWei)
	if head.BaseFee == nil {
		return floor, nil // non-1559 chain: just the floor
	}
	gp := new(big.Int).Add(new(big.Int).Mul(head.BaseFee, big.NewInt(2)), floor)
	if gp.Cmp(floor) < 0 {
		gp = floor
	}
	return gp, nil
}

func (b *TxBuild) Transfer(ctx context.Context, to string, value *big.Int) (common.Hash, error) {
	nonce, err := b.client.PendingNonceAt(ctx, b.Sender())
	if err != nil {
		return common.Hash{}, err
	}

	gasLimit := uint64(21000)
	gasPrice, err := b.dynamicGasPrice(ctx)
	if err != nil {
		return common.Hash{}, err
	}

	toAddress := common.HexToAddress(to)
	unsignedTx := types.NewTx(&types.LegacyTx{
		Nonce:    nonce,
		To:       &toAddress,
		Value:    value,
		Gas:      gasLimit,
		GasPrice: gasPrice,
	})

	signedTx, err := types.SignTx(unsignedTx, b.signer, b.privateKey)
	if err != nil {
		return common.Hash{}, err
	}

	return signedTx.Hash(), b.client.SendTransaction(ctx, signedTx)
}
