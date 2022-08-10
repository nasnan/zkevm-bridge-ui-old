import {
  createContext,
  FC,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { BigNumber, constants as ethersConstants } from "ethers";
import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import axios from "axios";

import tokenIconDefaultUrl from "src/assets/icons/tokens/erc20-icon.svg";
import { Erc20__factory } from "src/types/contracts/erc-20";
import { getCustomTokens, cleanupCustomTokens } from "src/adapters/storage";
import { useEnvContext } from "src/contexts/env.context";
import { useErrorContext } from "src/contexts/error.context";
import { Chain, Env, Token } from "src/domain";
import { getEthereumErc20Tokens } from "src/adapters/tokens";
import { useBridgeContext } from "src/contexts/bridge.context";
import { getEtherToken } from "src/constants";
import * as ethereum from "src/adapters/ethereum";

interface AddWrappedTokenParams {
  token: Token;
}

interface GetTokenFromAddressParams {
  address: string;
  chain: Chain;
}

interface GetTokenParams {
  env: Env;
  tokenAddress: string;
  originNetwork: number;
  chain: Chain;
}

interface GetErc20TokenBalanceParams {
  chain: Chain;
  tokenAddress: string;
  accountAddress: string;
}

interface IsContractAllowedToSpendTokenParams {
  token: Token;
  amount: BigNumber;
  provider: JsonRpcProvider;
  owner: string;
  spender: string;
}

interface ApproveParams {
  token: Token;
  amount: BigNumber;
  provider: Web3Provider;
  owner: string;
  spender: string;
}

interface TokensContext {
  tokens?: Token[];
  addWrappedToken: (params: AddWrappedTokenParams) => Promise<Token>;
  getTokenFromAddress: (params: GetTokenFromAddressParams) => Promise<Token>;
  getToken: (params: GetTokenParams) => Promise<Token>;
  getErc20TokenBalance: (params: GetErc20TokenBalanceParams) => Promise<BigNumber>;
  isContractAllowedToSpendToken: (params: IsContractAllowedToSpendTokenParams) => Promise<boolean>;
  approve: (params: ApproveParams) => Promise<void>;
}

const tokensContextNotReadyMsg = "The bridge context is not yet ready";

const tokensContext = createContext<TokensContext>({
  addWrappedToken: () => {
    return Promise.reject(tokensContextNotReadyMsg);
  },
  getTokenFromAddress: () => {
    return Promise.reject(tokensContextNotReadyMsg);
  },
  getToken: () => {
    return Promise.reject(tokensContextNotReadyMsg);
  },
  getErc20TokenBalance: () => {
    return Promise.reject(tokensContextNotReadyMsg);
  },
  isContractAllowedToSpendToken: () => {
    return Promise.reject(tokensContextNotReadyMsg);
  },
  approve: () => {
    return Promise.reject(tokensContextNotReadyMsg);
  },
});

const TokensProvider: FC<PropsWithChildren> = (props) => {
  const env = useEnvContext();
  const { notifyError } = useErrorContext();
  const { getNativeTokenInfo, computeWrappedTokenAddress } = useBridgeContext();
  const [tokens, setTokens] = useState<Token[]>();

  /**
   * Provided a token, if its property wrappedAddresses is missing, adds it and returns the new token
   */
  const addWrappedToken = useCallback(
    ({ token }: AddWrappedTokenParams): Promise<Token> => {
      if (token.wrappedToken) {
        return Promise.resolve(token);
      } else {
        if (!env) {
          throw Error("The env is not available");
        }
        const ethereumChain = env.chains[0];
        const polygonZkEVMChain = env.chains[1];
        const nativeChain =
          token.chainId === ethereumChain.chainId ? ethereumChain : polygonZkEVMChain;
        const wrappedChain =
          nativeChain.chainId === ethereumChain.chainId ? polygonZkEVMChain : ethereumChain;

        // first we check if the provided address belongs to a wrapped token
        return getNativeTokenInfo({ token, chain: nativeChain })
          .then(({ originalNetwork, originalTokenAddress }) => {
            // if this is the case we use originalTokenAddress as native and token.address as wrapped
            const originalTokenChain = env?.chains.find(
              (chain) => chain.networkId === originalNetwork
            );
            if (originalTokenChain === undefined) {
              throw Error(
                `Could not find a chain that matched the originalNetwork ${originalNetwork}`
              );
            } else {
              const newToken: Token = {
                ...token,
                address: originalTokenAddress,
                chainId: originalTokenChain.chainId,
                wrappedToken: {
                  address: token.address,
                  chainId: nativeChain.chainId,
                },
              };
              return newToken;
            }
          })
          .catch(() => {
            // if the provided address is native we compute the wrapped address
            return computeWrappedTokenAddress({
              token,
              nativeChain,
              otherChain: wrappedChain,
            })
              .then((wrappedAddress) => {
                const newToken: Token = {
                  ...token,
                  wrappedToken: {
                    address: wrappedAddress,
                    chainId: wrappedChain.chainId,
                  },
                };
                return newToken;
              })
              .catch(() => Promise.resolve(token));
          });
      }
    },
    [env, computeWrappedTokenAddress, getNativeTokenInfo]
  );

  const getTokenFromAddress = useCallback(
    async ({ address, chain }: GetTokenFromAddressParams): Promise<Token> => {
      const erc20Contract = Erc20__factory.connect(address, chain.provider);
      const name = await erc20Contract.name();
      const decimals = await erc20Contract.decimals();
      const symbol = await erc20Contract.symbol();
      const chainId = chain.chainId;
      const trustWalletLogoUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${address}/logo.png`;
      const logoURI = await axios
        .head(trustWalletLogoUrl)
        .then(() => trustWalletLogoUrl)
        .catch(() => tokenIconDefaultUrl);
      const token: Token = {
        name,
        decimals,
        symbol,
        address,
        chainId,
        logoURI,
      };
      return addWrappedToken({ token });
    },
    [addWrappedToken]
  );

  const getToken = useCallback(
    async ({ env, tokenAddress, originNetwork, chain }: GetTokenParams): Promise<Token> => {
      const token = [...getCustomTokens(), ...(tokens || [getEtherToken(chain)])].find(
        (token) =>
          token.address === tokenAddress ||
          (token.wrappedToken && token.wrappedToken.address === tokenAddress)
      );

      if (token) {
        return token;
      } else {
        const chain = env.chains.find((chain) => chain.networkId === originNetwork);

        if (chain) {
          return await getTokenFromAddress({ address: tokenAddress, chain }).catch(() => {
            throw new Error(
              `The token with the address "${tokenAddress}" could not be found either in the list of supported Tokens or in the blockchain with network id "${originNetwork}"`
            );
          });
        } else {
          throw new Error(
            `The token with the address "${tokenAddress}" could not be found in the list of supported Tokens and the provided network id "${originNetwork}" is not supported`
          );
        }
      }
    },
    [tokens, getTokenFromAddress]
  );

  const getErc20TokenBalance = useCallback(
    async ({ chain, tokenAddress, accountAddress }: GetErc20TokenBalanceParams) => {
      const isTokenEther = tokenAddress === ethersConstants.AddressZero;
      if (isTokenEther) {
        return Promise.reject(new Error("Ether is not supported as ERC20 token"));
      }
      const erc20Contract = Erc20__factory.connect(tokenAddress, chain.provider);
      return await erc20Contract.balanceOf(accountAddress);
    },
    []
  );

  const isContractAllowedToSpendToken = useCallback(
    async ({ token, amount, provider, owner, spender }: IsContractAllowedToSpendTokenParams) => {
      return ethereum.isContractAllowedToSpendToken({ token, amount, provider, owner, spender });
    },
    []
  );

  const approve = useCallback(({ token, amount, provider, owner, spender }: ApproveParams) => {
    return ethereum.approve({ token, amount, provider, owner, spender });
  }, []);

  // initialize tokens
  useEffect(() => {
    if (env) {
      const ethereumChain = env.chains[0];
      getEthereumErc20Tokens()
        .then((ethereumErc20Tokens) =>
          Promise.all(
            ethereumErc20Tokens
              .filter((token) => token.chainId === ethereumChain.chainId)
              .map((token) => addWrappedToken({ token }))
          )
            .then((chainTokens) => {
              const tokens = [getEtherToken(ethereumChain), ...chainTokens];
              cleanupCustomTokens(tokens);
              setTokens(tokens);
            })
            .catch(notifyError)
        )
        .catch(notifyError);
    }
  }, [env, addWrappedToken, notifyError]);

  const value = useMemo(() => {
    return {
      tokens,
      getTokenFromAddress,
      getToken,
      getErc20TokenBalance,
      addWrappedToken,
      isContractAllowedToSpendToken,
      approve,
    };
  }, [
    tokens,
    getTokenFromAddress,
    getToken,
    getErc20TokenBalance,
    addWrappedToken,
    isContractAllowedToSpendToken,
    approve,
  ]);

  return <tokensContext.Provider value={value} {...props} />;
};

const useTokensContext = (): TokensContext => {
  return useContext(tokensContext);
};

export { TokensProvider, useTokensContext };
